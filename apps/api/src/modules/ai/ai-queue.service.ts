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
import { and, eq, inArray, lt } from 'drizzle-orm';
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
    // 這個時間點必須早於 worker 開始消費，才能區分「上個行程的孤兒」與「本行程剛接手的」。
    const startedAt = new Date();

    // 用 duplicate() 而非共用連線：BullMQ 的阻塞式指令會獨佔連線，
    // 與其他 Redis 操作共用會互相卡住。
    const connection = this.redis.duplicate();

    // **佇列必須依 QUEUE_PREFIX 隔離。**
    //
    // 任務內容只是一個 aiJobId，實際狀態在 PostgreSQL。因此兩個連到同一個 Redis、
    // 用同一個佇列名稱、但指向**不同資料庫**的後端（例如 pnpm dev 的 :4000 與
    // 端到端測試的 :4101）會互相搶任務：搶到的那個在自己的資料庫裡找不到那筆
    // ai_jobs，任務就永遠停在 pending，而且兩邊的 log 都不會有錯誤。
    //
    // 這個變數原本宣告了卻沒有人用，實際排查時就是這樣被咬到的。
    const prefix = this.env.QUEUE_PREFIX;

    this.queue = new Queue(QUEUE_QUESTION_ANALYSIS, { connection, prefix });
    this.worker = new Worker(
      QUEUE_QUESTION_ANALYSIS,
      async (job: Job<AiJobPayload>) => this.process(job),
      {
        connection: this.redis.duplicate(),
        prefix,
        // 併發交給 AiConcurrencyLimiter 控制，這裡放行即可，
        // 兩處都設會讓實際併發變得難以推理。
        concurrency: this.env.NVIDIA_MAX_CONCURRENT,
      },
    );

    // 佇列說失敗了，資料庫也要跟著標記。
    //
    // process() 的 catch 只在「工作真的拋錯」時會跑到。worker 行程被殺掉時
    // （nest watch 重新編譯、Ctrl+C、當掉）那段程式碼根本不會執行，
    // 但 BullMQ 會另外把任務判定為 stalled 並標成 failed——
    // 於是佇列說 failed、資料庫還停在 pending 或 active，兩邊永遠對不起來。
    // 使用者看到的就是一個永遠不會結束、也永遠不報錯的分析。
    this.worker.on('failed', (job, error) => {
      this.logger.error(`任務 ${job?.id ?? '?'} 失敗：${error.message}`);
      const aiJobId = (job?.data as AiJobPayload | undefined)?.aiJobId;
      if (!aiJobId) return;
      void this.markFailedIfUnfinished(aiJobId, error.message);
    });

    // 用 worker 建立之前的時間點當界線，避免把「這個行程剛接手的任務」也一起判死。
    void this.reconcileOrphanedJobs(startedAt);

    this.logger.log(`AI 佇列已啟動（worker 併發 ${this.env.NVIDIA_MAX_CONCURRENT}）`);
  }

  /**
   * 啟動時把上一個行程留下的未完成任務標記為失敗。
   *
   * worker 與 API 同一個行程，因此啟動當下不可能有任務「正在執行」——
   * 資料庫裡還停在 pending / active 的，一定是上次行程結束時被中斷的孤兒。
   * 不清掉的話，那些任務會永遠停在進度條上，使用者只能一直等。
   */
  private async reconcileOrphanedJobs(before: Date): Promise<void> {
    try {
      const orphans = await this.database.db
        .update(schema.aiJobs)
        .set({
          status: 'failed',
          errorCode: ERROR_CODES.AI_PROVIDER_UNAVAILABLE,
          errorMessage: '後端在分析進行中重新啟動，這個任務已中斷。可以按重跑再試一次。',
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            inArray(schema.aiJobs.status, ['pending', 'active', 'retrying']),
            lt(schema.aiJobs.updatedAt, before),
          ),
        )
        .returning({ id: schema.aiJobs.id });

      if (orphans.length > 0) {
        this.logger.warn(`已將 ${orphans.length} 筆上次中斷的 AI 任務標記為失敗`);
      }
    } catch (error) {
      this.logger.error(`清理中斷任務失敗：${describe(error)}`);
    }
  }

  /** 只在任務還沒有結束狀態時才標記失敗，避免覆蓋掉已完成的結果。 */
  private async markFailedIfUnfinished(aiJobId: string, message: string): Promise<void> {
    try {
      await this.database.db
        .update(schema.aiJobs)
        .set({
          status: 'failed',
          errorCode: ERROR_CODES.AI_PROVIDER_UNAVAILABLE,
          errorMessage: message.slice(0, 1000),
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.aiJobs.id, aiJobId),
            inArray(schema.aiJobs.status, ['pending', 'active', 'retrying']),
          ),
        );
    } catch (error) {
      this.logger.error(`同步任務失敗狀態時出錯：${describe(error)}`);
    }
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
      //
      // 整個任務再套一層總時限：單次請求的逾時只保護「一次呼叫」，
      // 但一個任務有三個階段、每階段還可能重試，加起來仍可能長到不合理。
      // 這一層保證任務一定會結束，不會永遠停在 active 讓使用者一直等。
      // BULLMQ_JOB_TIMEOUT_MS 原本宣告了卻沒有人用，這裡才真正接上。
      const result = await withDeadline(
        isAggregate(input)
          ? this.aggregate.run(input, report)
          : this.analysis.run(input, report),
        this.env.BULLMQ_JOB_TIMEOUT_MS,
      );
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

/**
 * 給一段非同步工作套上總時限。
 *
 * 超時會讓任務以明確的錯誤結束，而不是永遠停在 active——
 * 使用者看得到「失敗了、可以重跑」，而不是一個不會動的進度條。
 *
 * 注意：這只保證「任務會被標記結束」，底層那次呼叫仍可能還在跑完才罷休。
 * 真正的取消要靠 provider 自己的 AbortController（見 NvidiaAiProvider）。
 * 這一層是最後一道防線，不是第一道。
 */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AppException(
                ERROR_CODES.AI_PROVIDER_UNAVAILABLE,
                `分析超過 ${Math.round(ms / 1000)} 秒仍未完成，已中止。可以按重跑再試一次。`,
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
