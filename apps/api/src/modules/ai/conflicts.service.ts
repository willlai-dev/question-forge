import { Inject, Injectable, Logger } from '@nestjs/common';
import { computeQuestionContentHash } from '@repo/contracts/server';
import {
  ERROR_CODES,
  type AnswerConflictResponse,
  type ListConflictsQuery,
  type PaginationMeta,
  type ResolveConflictRequest,
} from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { DATABASE } from '../../infra/infra.module';

/**
 * 答案衝突的人工裁決（規格 §10）。
 *
 * **AI 永遠不會自己改答案** —— 它只能建立一筆待審爭議。
 * 這個 service 是唯一能因為爭議而改動題庫答案的地方，而且一定由人觸發。
 */
@Injectable()
export class ConflictsService {
  private readonly logger = new Logger(ConflictsService.name);

  constructor(@Inject(DATABASE) private readonly database: DatabaseHandle) {}

  async list(
    userId: string,
    query: ListConflictsQuery,
  ): Promise<{ items: AnswerConflictResponse[]; pagination: PaginationMeta }> {
    const { db } = this.database;
    const conditions: SQL[] = [eq(schema.questions.userId, userId)];
    if (query.reviewStatus) conditions.push(eq(schema.answerConflicts.reviewStatus, query.reviewStatus));
    const where = and(...conditions);

    const totals = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.answerConflicts)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.answerConflicts.questionId))
      .where(where);

    const rows = await db
      .select({
        conflict: schema.answerConflicts,
        question: schema.questions,
        subjectName: schema.subjects.name,
      })
      .from(schema.answerConflicts)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.answerConflicts.questionId))
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questions.subjectId))
      .where(where)
      .orderBy(desc(schema.answerConflicts.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const items = await Promise.all(rows.map((row) => this.hydrate(row)));
    const total = totals[0]?.total ?? 0;

    return {
      items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  }

  async get(userId: string, id: string): Promise<AnswerConflictResponse> {
    const rows = await this.database.db
      .select({
        conflict: schema.answerConflicts,
        question: schema.questions,
        subjectName: schema.subjects.name,
      })
      .from(schema.answerConflicts)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.answerConflicts.questionId))
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questions.subjectId))
      .where(and(eq(schema.answerConflicts.id, id), eq(schema.questions.userId, userId)))
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppException(ERROR_CODES.ANSWER_CONFLICT_NOT_FOUND, '找不到指定的答案爭議。');
    return this.hydrate(row);
  }

  /**
   * 裁決爭議。五種決策對應規格 §10：
   *
   *   - `kept_original`：維持原答案，題目回到 active
   *   - `answer_updated`：**修改題庫答案**（唯一會改動答案的路徑，且必須由人指定）
   *   - `explanation_updated`：只更新解析，答案不動
   *   - `marked_disputed`：確認有爭議，題目維持 disputed 並持續排除於統計之外
   *   - `question_excluded`：這題不再出現在作答中
   */
  async resolve(
    userId: string,
    id: string,
    dto: ResolveConflictRequest,
  ): Promise<AnswerConflictResponse> {
    const rows = await this.database.db
      .select({ conflict: schema.answerConflicts, question: schema.questions })
      .from(schema.answerConflicts)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.answerConflicts.questionId))
      .where(and(eq(schema.answerConflicts.id, id), eq(schema.questions.userId, userId)))
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppException(ERROR_CODES.ANSWER_CONFLICT_NOT_FOUND, '找不到指定的答案爭議。');
    if (row.conflict.reviewStatus !== 'pending') {
      throw new AppException(ERROR_CODES.ANSWER_CONFLICT_ALREADY_RESOLVED, '這筆爭議已經處理過了。');
    }

    const questionId = row.conflict.questionId;
    const now = new Date();

    await this.database.db.transaction(async (tx) => {
      if (dto.decision === 'answer_updated') {
        await this.applyAnswerUpdate(tx, questionId, dto.correctAnswers!, row.question);
      }

      if (dto.decision === 'explanation_updated') {
        await tx
          .update(schema.questions)
          .set({ explanation: dto.explanation!, status: 'active', updatedAt: now })
          .where(eq(schema.questions.id, questionId));
      }

      if (dto.decision === 'kept_original') {
        await tx
          .update(schema.questions)
          .set({ status: 'active', updatedAt: now })
          .where(eq(schema.questions.id, questionId));
      }

      if (dto.decision === 'question_excluded') {
        await tx
          .update(schema.questions)
          .set({ status: 'excluded', updatedAt: now })
          .where(eq(schema.questions.id, questionId));
      }

      // marked_disputed：題目維持 disputed，作答繼續標為 provisional 而不計入診斷。

      await tx
        .update(schema.answerConflicts)
        .set({
          reviewStatus: dto.decision,
          reviewedAt: now,
          reviewNote: dto.reviewNote ?? null,
          resolvedBy: userId,
          updatedAt: now,
        })
        .where(eq(schema.answerConflicts.id, id));

      // 爭議解除後，這題既有的暫記作答恢復計入統計。
      // 仍標為 disputed 的情況不解除 —— 那正是要繼續排除的狀態。
      if (dto.decision !== 'marked_disputed') {
        await tx
          .update(schema.userAnswers)
          .set({ isProvisional: false, updatedAt: now })
          .where(
            and(
              eq(schema.userAnswers.questionId, questionId),
              eq(schema.userAnswers.isProvisional, true),
            ),
          );
      }
    });

    this.logger.log(`答案爭議 ${id} 已裁決為 ${dto.decision}`);
    return this.get(userId, id);
  }

  /**
   * 修改題庫答案。
   *
   * 改動選項的正確性會改變 content_hash，這正是我們要的：
   * 既有的 AI 解析會因此自動失效（規格 §12 的快取判準），
   * 下次分析會重新研究，而不是沿用一份基於舊答案的解析。
   */
  private async applyAnswerUpdate(
    tx: Parameters<Parameters<DatabaseHandle['db']['transaction']>[0]>[0],
    questionId: string,
    correctAnswers: string[],
    question: typeof schema.questions.$inferSelect,
  ): Promise<void> {
    const options = await tx
      .select()
      .from(schema.questionOptions)
      .where(eq(schema.questionOptions.questionId, questionId))
      .orderBy(asc(schema.questionOptions.sortOrder));

    const target = new Set(correctAnswers.map((key) => key.trim().toUpperCase()));
    const unknown = [...target].filter((key) => !options.some((option) => option.key === key));
    if (unknown.length > 0) {
      throw new AppException(
        ERROR_CODES.VALIDATION_FAILED,
        `選項代號 ${unknown.join('、')} 不屬於這一題。`,
      );
    }
    if (question.type === 'single_choice' && target.size !== 1) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, '單選題必須恰好一個正確答案。');
    }
    if (question.type === 'multiple_choice' && target.size < 2) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, '複選題至少需要兩個正確答案。');
    }

    for (const option of options) {
      const shouldBeCorrect = target.has(option.key);
      if (option.isCorrect === shouldBeCorrect) continue;
      await tx
        .update(schema.questionOptions)
        .set({ isCorrect: shouldBeCorrect })
        .where(eq(schema.questionOptions.id, option.id));
    }

    const contentHash = computeQuestionContentHash({
      type: question.type,
      stem: question.stem,
      options: options.map((option) => ({
        key: option.key,
        text: option.text,
        isCorrect: target.has(option.key),
      })),
    });

    const nextVersion = question.currentVersion + 1;
    const now = new Date();

    await tx
      .update(schema.questions)
      .set({
        status: 'active',
        contentHash,
        currentVersion: nextVersion,
        updatedAt: now,
      })
      .where(eq(schema.questions.id, questionId));

    // 留下版本快照，讓「答案是什麼時候、因為什麼被改的」有跡可循。
    await tx.insert(schema.questionVersions).values({
      questionId,
      version: nextVersion,
      contentHash,
      snapshot: {
        type: question.type,
        stem: question.stem,
        options: options.map((option) => ({
          key: option.key,
          text: option.text,
          isCorrect: target.has(option.key),
        })),
        explanation: question.explanation,
        questionNumber: question.questionNumber,
      },
      changedFields: ['options'],
      changeReason: '答案爭議裁決：修改正確答案',
    });
  }

  private async hydrate(row: {
    conflict: typeof schema.answerConflicts.$inferSelect;
    question: typeof schema.questions.$inferSelect;
    subjectName: string;
  }): Promise<AnswerConflictResponse> {
    const options = await this.database.db
      .select()
      .from(schema.questionOptions)
      .where(eq(schema.questionOptions.questionId, row.question.id))
      .orderBy(asc(schema.questionOptions.sortOrder));

    const sources = row.conflict.evidenceSetId
      ? await this.database.db
          .select()
          .from(schema.questionEvidenceSources)
          .where(eq(schema.questionEvidenceSources.evidenceSetId, row.conflict.evidenceSetId))
      : [];

    return {
      id: row.conflict.id,
      questionId: row.question.id,
      questionStem: row.question.stem,
      questionNumber: row.question.questionNumber,
      subjectName: row.subjectName,
      options: options.map((o) => ({ key: o.key, text: o.text, isCorrect: o.isCorrect })),
      storedAnswers: row.conflict.storedAnswers,
      verifiedAnswers: row.conflict.verifiedAnswers,
      confidence: row.conflict.confidence === null ? 0 : Number(row.conflict.confidence),
      conflictReason: row.conflict.conflictReason,
      sourceIds: row.conflict.sourceIds ?? [],
      sources: sources.map((source) => ({
        sourceId: source.sourceId,
        url: source.url,
        domain: source.domain,
        title: source.title,
        publishedDate: source.publishedDate,
        fetchedAt: source.fetchedAt.toISOString(),
        trustTier: source.trustTier as AnswerConflictResponse['sources'][number]['trustTier'],
        contentSnippet: source.contentSnippet ?? '',
        searchQuery: source.searchQuery,
        rank: source.rank,
        score: source.score === null ? null : Number(source.score),
        isUsed: source.isUsed,
      })),
      reviewStatus: row.conflict.reviewStatus as AnswerConflictResponse['reviewStatus'],
      reviewedAt: row.conflict.reviewedAt?.toISOString() ?? null,
      reviewNote: row.conflict.reviewNote,
      createdAt: row.conflict.createdAt.toISOString(),
    };
  }
}
