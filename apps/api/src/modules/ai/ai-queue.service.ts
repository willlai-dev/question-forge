import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { AI_PROGRESS_STEPS, ERROR_CODES, type AiProgressStep, type Env } from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { Queue, Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';

import { AppException } from '../../common/app.exception';
import { ENV } from '../../config/env.config';
import { DATABASE, REDIS } from '../../infra/infra.module';
import { AggregateAnalysisService, type AggregateJobInput } from './aggregate-analysis.service';
import { QuestionAnalysisService, type AnalysisJobInput } from './question-analysis.service';

// BullMQ 不允許佇列名稱含冒號（它自己用冒號組 Redis key 的命名空間）。
export const QUEUE_QUESTION_ANALYSIS = 'ai-question-analysis';

/**
 * 佇列裡跑的任務。
 *
 * 兩種任務共用一條佇列與一個 worker：單一使用者、限流器本來就是全域的，
 * 第二條佇列只會多一組 Redis 連線而換不到任何東西。
 * 分派靠 payload 上的 `kind`——舊的單題任務沒有這個欄位，因此以「沒有 kind」判定。
 */
export type AiJobPayload = AnalysisJobInput | AggregateJobInput;

/**
 * AI 任務佇列。
 *
 * 為什麼一定要非同步：規劃階段實測模型延遲 4～8 秒，且伺服器自報排隊 41 筆；
 * 三階段串起來同步等待必然逾時。前端改為輪詢 `GET /ai/jobs/:id`（規格 §13）。
 *
 * **進度寫在 PostgreSQL 而不是問 BullMQ**：job 完成或失敗後 BullMQ 會清掉，
 * 但使用者仍需要看得到「上次那個分析怎麼了」。
 *
 * Worker 與 API 同進程（單一使用者、單一實例，跨行程協調沒有對象）。
 */
@Injectable()
export class AiQueueService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AiQueueService.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(ENV) private readonly env: Env,
    private readonly analysis: QuestionAnalysisService,
    private readonly aggregate: AggregateAnalysisService,
  ) {}

  onModuleInit(): void {
    // 用 duplicate() 而非共用連線：BullMQ 的阻塞式指令會獨佔連線，
    // 與其他 Redis 操作共用會互相卡住。
    const connection = this.redis.duplicate();

    this.queue = new Queue(QUEUE_QUESTION_ANALYSIS, { connection });
    this.worker = new Worker(
      QUEUE_QUESTION_ANALYSIS,
      async (job: Job<AnalysisJobInput>) => this.process(job),
      {
        connection: this.redis.duplicate(),
        // 併發交給 AiConcurrencyLimiter 控制，這裡放行即可，
        // 兩處都設會讓實際併發變得難以推理。
        concurrency: this.env.NVIDIA_MAX_CONCURRENT,
      },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(`任務 ${job?.id ?? '?'} 失敗：${error.message}`);
    });

    this.logger.log(`AI 佇列已啟動（worker 併發 ${this.env.NVIDIA_MAX_CONCURRENT}）`);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.worker?.close(), this.queue?.close()]);
  }

  /**
   * 送出任務。
   *
   * `idempotencyKey` 同時作為 BullMQ 的 jobId：
   * 資料庫唯一約束與佇列去重雙重保證同一任務不會重複執行（規格 §14）。
   */
  async enqueue(input: AiJobPayload, idempotencyKey: string, priority: number): Promise<string> {
    if (!this.queue) {
      throw new AppException(ERROR_CODES.DEPENDENCY_UNAVAILABLE, 'AI 佇列尚未就緒。');
    }

    try {
      const job = await this.queue.add('analyze', input, {
        jobId: idempotencyKey,
        priority,
        attempts: 1, // 重試由 AiGateway 依錯誤類型決定，佇列層不重複重試
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86_400 },
      });
      return job.id ?? idempotencyKey;
    } catch (error) {
      // Redis 掛掉時 AI 功能不可用，但系統其餘部分照常運作。
      this.logger.error(`無法送出 AI 任務：${describe(error)}`);
      throw new AppException(
        ERROR_CODES.DEPENDENCY_UNAVAILABLE,
        'AI 佇列目前無法使用（Redis 未連線）。請先啟動 Redis：pnpm redis:up',
      );
    }
  }

  async cancel(idempotencyKey: string): Promise<void> {
    if (!this.queue) return;
    try {
      const job = await this.queue.getJob(idempotencyKey);
      // 已在執行中的任務無法中途撤掉，狀態改由資料庫標記為 cancelled。
      if (job && (await job.isWaiting())) await job.remove();
    } catch (error) {
      this.logger.warn(`取消佇列任務失敗：${describe(error)}`);
    }
  }

  private async process(job: Job<AiJobPayload>): Promise<void> {
    const input = job.data;
    const report = async (step: AiProgressStep): Promise<void> => {
      await this.updateJob(input.aiJobId, {
        progressStep: step,
        progressPct: AI_PROGRESS_STEPS[step].pct,
        status: step === 'COMPLETED' ? 'completed' : 'active',
      });
    };

    await this.updateJob(input.aiJobId, {
      status: 'active',
      progressStep: 'QUEUED',
      progressPct: 0,
      startedAt: new Date(),
      attempts: job.attemptsMade + 1,
    });

    try {
      // 分派靠 payload 的 kind：BullMQ 的 job name 目前沒被檢查，
      // 而且舊任務可能還躺在佇列裡，用資料本身判定比較穩。
      const result =
        isAggregate(input)
          ? await this.aggregate.run(input, report)
          : await this.analysis.run(input, report);
      await this.updateJob(input.aiJobId, {
        status: 'completed',
        progressStep: 'COMPLETED',
        progressPct: 100,
        finishedAt: new Date(),
        servedFromCache: result.servedFromCache,
      });
    } catch (error) {
      const code = error instanceof AppException ? error.code : ERROR_CODES.INTERNAL_ERROR;
      const message = error instanceof Error ? error.message : String(error);

      await this.updateJob(input.aiJobId, {
        status: 'failed',
        finishedAt: new Date(),
        errorCode: code,
        errorMessage: message.slice(0, 1000),
      });
      throw error;
    }
  }

  private async updateJob(
    aiJobId: string,
    values: Partial<typeof schema.aiJobs.$inferInsert>,
  ): Promise<void> {
    try {
      await this.database.db
        .update(schema.aiJobs)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(schema.aiJobs.id, aiJobId));
    } catch (error) {
      this.logger.error(`更新任務狀態失敗：${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 舊的單題任務沒有 kind 欄位，因此以「有沒有 kind」判定，而不是反過來。 */
function isAggregate(input: AiJobPayload): input is AggregateJobInput {
  return (input as AggregateJobInput).kind === 'aggregate_analysis';
}
