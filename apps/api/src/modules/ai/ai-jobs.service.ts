import { Inject, Injectable } from '@nestjs/common';
import {
  AI_PROGRESS_STEPS,
  ERROR_CODES,
  type AiJobResponse,
  type AnalyzeQuestionRequest,
  type ListAiJobsQuery,
  type PaginationMeta,
} from '@repo/contracts';
import { computeAiJobIdempotencyKey } from '@repo/contracts/server';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { DATABASE } from '../../infra/infra.module';
import { AiGatewayService } from './ai-gateway.service';
import { AiQueueService, QUEUE_QUESTION_ANALYSIS } from './ai-queue.service';
import { PromptSeedService } from './prompts/prompt-seed.service';

type JobRow = typeof schema.aiJobs.$inferSelect;

@Injectable()
export class AiJobsService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    private readonly queue: AiQueueService,
    private readonly gateway: AiGatewayService,
    private readonly promptSeed: PromptSeedService,
  ) {}

  /**
   * 啟動單題分析。
   *
   * 冪等鍵包含題目內容雜湊與 prompt／模型版本：
   * 內容沒變就會落在同一個鍵上，重複點擊只會拿到同一個任務，
   * 不會排出第二個一模一樣的分析（規格 §14）。
   */
  async analyzeQuestion(
    userId: string,
    questionId: string,
    dto: AnalyzeQuestionRequest,
  ): Promise<AiJobResponse> {
    const question = await this.loadQuestion(userId, questionId);

    if (dto.userAnswerId) await this.assertAnswerBelongsToQuestion(userId, dto.userAnswerId, questionId);

    const discriminator = [
      question.contentHash,
      this.gateway.model,
      this.promptSeed.activeVersion('final_explanation'),
      dto.userAnswerId ?? '-',
      // force 帶上時間戳，讓強制重跑一定會產生新任務。
      dto.force ? String(Date.now()) : 'cached',
    ].join(':');

    const idempotencyKey = computeAiJobIdempotencyKey({
      userId,
      jobType: 'question_analysis',
      questionId,
      discriminator,
    });

    const existing = await this.database.db
      .select()
      .from(schema.aiJobs)
      .where(eq(schema.aiJobs.idempotencyKey, idempotencyKey))
      .limit(1);

    // 同一個任務已存在且尚未結束或已成功 → 直接回傳它，不重複執行。
    if (existing[0] && existing[0].status !== 'failed' && existing[0].status !== 'cancelled') {
      return this.toResponse(existing[0]);
    }

    const inserted = await this.database.db
      .insert(schema.aiJobs)
      .values({
        userId,
        jobType: 'question_analysis',
        queue: QUEUE_QUESTION_ANALYSIS,
        idempotencyKey,
        questionId,
        userAnswerId: dto.userAnswerId ?? null,
        status: 'pending',
        progressStep: 'QUEUED',
        progressPct: 0,
        priority: dto.priority,
      })
      .onConflictDoUpdate({
        target: schema.aiJobs.idempotencyKey,
        set: {
          status: 'pending',
          progressStep: 'QUEUED',
          progressPct: 0,
          errorCode: null,
          errorMessage: null,
          finishedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning();

    const job = inserted[0]!;

    const bullmqJobId = await this.queue.enqueue(
      {
        aiJobId: job.id,
        userId,
        questionId,
        userAnswerId: dto.userAnswerId ?? null,
        force: dto.force,
      },
      idempotencyKey,
      dto.priority,
    );

    await this.database.db
      .update(schema.aiJobs)
      .set({ bullmqJobId, updatedAt: new Date() })
      .where(eq(schema.aiJobs.id, job.id));

    return this.toResponse({ ...job, bullmqJobId });
  }

  async get(userId: string, id: string): Promise<AiJobResponse> {
    const rows = await this.database.db
      .select()
      .from(schema.aiJobs)
      .where(and(eq(schema.aiJobs.id, id), eq(schema.aiJobs.userId, userId)))
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppException(ERROR_CODES.AI_JOB_NOT_FOUND, '找不到指定的 AI 任務。');
    return this.toResponse(row);
  }

  async list(
    userId: string,
    query: ListAiJobsQuery,
  ): Promise<{ items: AiJobResponse[]; pagination: PaginationMeta }> {
    const conditions: SQL[] = [eq(schema.aiJobs.userId, userId)];
    if (query.status) conditions.push(eq(schema.aiJobs.status, query.status));
    if (query.questionId) conditions.push(eq(schema.aiJobs.questionId, query.questionId));
    const where = and(...conditions);

    const totals = await this.database.db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.aiJobs)
      .where(where);

    const rows = await this.database.db
      .select()
      .from(schema.aiJobs)
      .where(where)
      .orderBy(desc(schema.aiJobs.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const total = totals[0]?.total ?? 0;
    return {
      items: rows.map((row) => this.toResponse(row)),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  }

  async cancel(userId: string, id: string): Promise<AiJobResponse> {
    const rows = await this.database.db
      .select()
      .from(schema.aiJobs)
      .where(and(eq(schema.aiJobs.id, id), eq(schema.aiJobs.userId, userId)))
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppException(ERROR_CODES.AI_JOB_NOT_FOUND, '找不到指定的 AI 任務。');

    if (row.status === 'completed' || row.status === 'cancelled') {
      throw new AppException(ERROR_CODES.AI_JOB_NOT_CANCELLABLE, '這個任務已經結束了。');
    }

    await this.queue.cancel(row.idempotencyKey);
    await this.database.db
      .update(schema.aiJobs)
      .set({ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.aiJobs.id, id));

    return this.get(userId, id);
  }

  /** 失敗的任務重跑。沿用同一筆紀錄，讓 attempts 累加而不是產生一堆孤兒任務。 */
  async retry(userId: string, id: string): Promise<AiJobResponse> {
    const rows = await this.database.db
      .select()
      .from(schema.aiJobs)
      .where(and(eq(schema.aiJobs.id, id), eq(schema.aiJobs.userId, userId)))
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppException(ERROR_CODES.AI_JOB_NOT_FOUND, '找不到指定的 AI 任務。');
    if (row.status !== 'failed' && row.status !== 'cancelled') {
      throw new AppException(ERROR_CODES.CONFLICT, '只有失敗或已取消的任務可以重跑。');
    }
    if (!row.questionId) {
      throw new AppException(ERROR_CODES.CONFLICT, '這個任務沒有對應的題目，無法重跑。');
    }

    await this.database.db
      .update(schema.aiJobs)
      .set({
        status: 'pending',
        progressStep: 'QUEUED',
        progressPct: 0,
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
        cancelledAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.aiJobs.id, id));

    // 重跑一律強制重新分析：既然上次失敗了，沿用快取沒有意義。
    await this.queue.enqueue(
      {
        aiJobId: row.id,
        userId,
        questionId: row.questionId,
        userAnswerId: row.userAnswerId,
        force: true,
      },
      `${row.idempotencyKey}:retry:${row.attempts + 1}`,
      row.priority,
    );

    return this.get(userId, id);
  }

  private async loadQuestion(userId: string, questionId: string) {
    const rows = await this.database.db
      .select({
        id: schema.questions.id,
        contentHash: schema.questions.contentHash,
        status: schema.questions.status,
      })
      .from(schema.questions)
      .where(
        and(
          eq(schema.questions.id, questionId),
          eq(schema.questions.userId, userId),
          isNull(schema.questions.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppException(ERROR_CODES.QUESTION_NOT_FOUND, '找不到指定的題目。');
    return row;
  }

  private async assertAnswerBelongsToQuestion(
    userId: string,
    answerId: string,
    questionId: string,
  ): Promise<void> {
    const rows = await this.database.db
      .select({ id: schema.userAnswers.id })
      .from(schema.userAnswers)
      .where(
        and(
          eq(schema.userAnswers.id, answerId),
          eq(schema.userAnswers.userId, userId),
          eq(schema.userAnswers.questionId, questionId),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      throw new AppException(ERROR_CODES.NOT_FOUND, '指定的作答紀錄不屬於這一題。');
    }
  }

  private toResponse(row: JobRow): AiJobResponse {
    const step = row.progressStep as keyof typeof AI_PROGRESS_STEPS;
    return {
      id: row.id,
      jobType: row.jobType as AiJobResponse['jobType'],
      status: row.status as AiJobResponse['status'],
      progressStep: (AI_PROGRESS_STEPS[step] ? step : 'QUEUED') as AiJobResponse['progressStep'],
      progressPct: row.progressPct,
      questionId: row.questionId,
      priority: row.priority,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      servedFromCache: row.servedFromCache,
    };
  }
}
