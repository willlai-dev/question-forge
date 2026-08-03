import { Inject, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  type CreateMistakePracticeRequest,
  type ListMistakesQuery,
  type MistakeDetailResponse,
  type MistakeResponse,
  type MistakeStatsResponse,
  type PaginationMeta,
  type QuizSessionResponse,
} from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { diagnosticMistakeScope } from '../../common/diagnostic-scope';
import { DATABASE } from '../../infra/infra.module';
import { QuizSessionsService } from './quiz-sessions.service';

/**
 * 錯題本的讀取與重練。
 *
 * 寫入（紀錄的建立與更新）在 MistakeRecordsService，由作答流程觸發；
 * 這裡只負責查詢，以及把篩選條件轉成一個新的作答場次（FR-MIS-04）。
 */
@Injectable()
export class MistakesService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    private readonly quizSessions: QuizSessionsService,
  ) {}

  async list(
    userId: string,
    query: ListMistakesQuery,
  ): Promise<{ items: MistakeResponse[]; pagination: PaginationMeta }> {
    const { db } = this.database;
    const where = and(...this.buildConditions(userId, query));

    const totalRows = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.mistakeRecords)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.mistakeRecords.questionId))
      .where(where);
    const total = totalRows[0]?.total ?? 0;

    const direction = query.order === 'asc' ? asc : desc;
    const sortColumn = {
      lastMissed: schema.mistakeRecords.lastMissedAt,
      mistakeCount: schema.mistakeRecords.mistakeCount,
      accuracy: schema.mistakeRecords.recentAccuracy,
    }[query.sort];

    const rows = await db
      .select(this.selection())
      .from(schema.mistakeRecords)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.mistakeRecords.questionId))
      .innerJoin(
        schema.questionGroups,
        eq(schema.questionGroups.id, schema.questions.questionGroupId),
      )
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questions.subjectId))
      .leftJoin(schema.chapters, eq(schema.chapters.id, schema.questions.chapterId))
      .where(where)
      .orderBy(direction(sortColumn), desc(schema.mistakeRecords.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

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

  async detail(userId: string, questionId: string): Promise<MistakeDetailResponse> {
    const { db } = this.database;

    const rows = await db
      .select({ ...this.selection(), mistakeRecordId: schema.mistakeRecords.id })
      .from(schema.mistakeRecords)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.mistakeRecords.questionId))
      .innerJoin(
        schema.questionGroups,
        eq(schema.questionGroups.id, schema.questions.questionGroupId),
      )
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questions.subjectId))
      .leftJoin(schema.chapters, eq(schema.chapters.id, schema.questions.chapterId))
      .where(
        and(
          eq(schema.mistakeRecords.questionId, questionId),
          // 與列表用同一組排除條件，否則列表看不到的題目卻能直接開詳情頁。
          diagnosticMistakeScope(userId),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppException(ERROR_CODES.NOT_FOUND, '錯題本中沒有這一題。');

    const options = await db
      .select()
      .from(schema.questionOptions)
      .where(eq(schema.questionOptions.questionId, questionId))
      .orderBy(asc(schema.questionOptions.sortOrder));

    // 只列出算數的作答。totalAttempts 是由非暫記的作答數算出來的
    // （見 MistakeRecordsService.recompute），這裡若不套同一個條件，
    // 畫面就會出現「總作答 3 次」上方列著 4 筆紀錄的矛盾。
    const attempts = await db
      .select()
      .from(schema.userAnswers)
      .where(
        and(
          eq(schema.userAnswers.userId, userId),
          eq(schema.userAnswers.questionId, questionId),
          eq(schema.userAnswers.isProvisional, false),
        ),
      )
      .orderBy(desc(schema.userAnswers.answeredAt));

    const knowledgeTags = await db
      .select({
        id: schema.knowledgeTags.id,
        name: schema.knowledgeTags.name,
        role: schema.questionKnowledgeTags.role,
      })
      .from(schema.questionKnowledgeTags)
      .innerJoin(
        schema.knowledgeTags,
        eq(schema.knowledgeTags.id, schema.questionKnowledgeTags.knowledgeTagId),
      )
      .where(eq(schema.questionKnowledgeTags.questionId, questionId));

    const errorTypes = await db
      .select({
        errorTypeId: schema.mistakeRecordErrorTypes.errorTypeId,
        code: schema.errorTypes.code,
        name: schema.errorTypes.name,
        occurrenceCount: schema.mistakeRecordErrorTypes.occurrenceCount,
        source: schema.mistakeRecordErrorTypes.source,
      })
      .from(schema.mistakeRecordErrorTypes)
      .innerJoin(
        schema.errorTypes,
        eq(schema.errorTypes.id, schema.mistakeRecordErrorTypes.errorTypeId),
      )
      .where(eq(schema.mistakeRecordErrorTypes.mistakeRecordId, row.mistakeRecordId))
      .orderBy(asc(schema.errorTypes.sortOrder));

    return {
      ...this.toResponse(row),
      options: options.map((o) => ({ key: o.key, text: o.text, isCorrect: o.isCorrect })),
      correctAnswers: options.filter((o) => o.isCorrect).map((o) => o.key),
      explanation: row.explanation,
      knowledgeTags,
      errorTypes: errorTypes.map((type) => ({
        ...type,
        source: type.source as 'manual' | 'ai',
      })),
      attempts: attempts.map((attempt) => ({
        answerId: attempt.id,
        quizSessionId: attempt.sessionId,
        selectedAnswers: attempt.selectedAnswers,
        correctAnswers: attempt.correctAnswersSnapshot,
        isCorrect: attempt.isCorrect,
        responseTimeMs: attempt.responseTimeMs,
        revealMode: attempt.revealMode,
        questionVersion: attempt.questionVersion,
        answeredAt: attempt.answeredAt.toISOString(),
      })),
    };
  }

  async stats(userId: string): Promise<MistakeStatsResponse> {
    const { db } = this.database;

    const totals = await db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${schema.mistakeRecords.masteryState} = 'active')::int`,
        improving: sql<number>`count(*) filter (where ${schema.mistakeRecords.masteryState} = 'improving')::int`,
        mastered: sql<number>`count(*) filter (where ${schema.mistakeRecords.masteryState} = 'mastered')::int`,
        resolved: sql<number>`count(*) filter (where ${schema.mistakeRecords.isResolved})::int`,
      })
      .from(schema.mistakeRecords)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.mistakeRecords.questionId))
      .where(diagnosticMistakeScope(userId));

    const bySubject = await db
      .select({
        subjectId: schema.subjects.id,
        subjectName: schema.subjects.name,
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${schema.mistakeRecords.masteryState} = 'active')::int`,
        mastered: sql<number>`count(*) filter (where ${schema.mistakeRecords.masteryState} = 'mastered')::int`,
      })
      .from(schema.mistakeRecords)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.mistakeRecords.questionId))
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questions.subjectId))
      .where(diagnosticMistakeScope(userId))
      .groupBy(schema.subjects.id, schema.subjects.name)
      .orderBy(desc(sql`count(*)`), asc(schema.subjects.name));

    const summary = totals[0] ?? {
      total: 0,
      active: 0,
      improving: 0,
      mastered: 0,
      resolved: 0,
    };

    return { ...summary, bySubject };
  }

  /** 依錯題本的篩選條件直接開一場重練（FR-MIS-04）。 */
  async createPractice(
    userId: string,
    dto: CreateMistakePracticeRequest,
  ): Promise<QuizSessionResponse> {
    const scopes: {
      scopeType: 'subject' | 'chapter' | 'question_group' | 'knowledge_tag';
      refId: string;
    }[] = [];
    if (dto.knowledgeTagId)
      scopes.push({ scopeType: 'knowledge_tag', refId: dto.knowledgeTagId });
    else if (dto.questionGroupId)
      scopes.push({ scopeType: 'question_group', refId: dto.questionGroupId });
    else if (dto.chapterId && dto.chapterId !== 'none')
      scopes.push({ scopeType: 'chapter', refId: dto.chapterId });
    else if (dto.subjectId) scopes.push({ scopeType: 'subject', refId: dto.subjectId });

    return this.quizSessions.create(userId, {
      mode: 'mistake_review',
      scopes,
      orderStrategy: dto.orderStrategy,
      shuffleOptions: dto.shuffleOptions,
      questionLimit: dto.questionLimit ?? null,
      revealMode: dto.revealMode,
      allowAnswerChange: dto.allowAnswerChange,
      onlyMistakes: true,
      masteryStates: dto.masteryStates,
    });
  }

  // ------------------------------------------------------------- helpers

  private buildConditions(userId: string, query: ListMistakesQuery): SQL[] {
    const conditions: SQL[] = [diagnosticMistakeScope(userId)];
    if (query.subjectId) conditions.push(eq(schema.questions.subjectId, query.subjectId));
    if (query.chapterId === 'none') conditions.push(isNull(schema.questions.chapterId));
    else if (query.chapterId) conditions.push(eq(schema.questions.chapterId, query.chapterId));
    if (query.questionGroupId)
      conditions.push(eq(schema.questions.questionGroupId, query.questionGroupId));
    if (query.masteryState)
      conditions.push(eq(schema.mistakeRecords.masteryState, query.masteryState));
    if (query.isResolved)
      conditions.push(eq(schema.mistakeRecords.isResolved, query.isResolved === 'true'));

    // 子查詢的欄位一律寫死資料表名稱限定，理由見 docs/ARCHITECTURE.md 的相關子查詢陷阱。
    if (query.knowledgeTagId) {
      conditions.push(
        sql`exists (select 1 from question_knowledge_tags qkt
             where qkt.question_id = mistake_records.question_id
               and qkt.knowledge_tag_id = ${query.knowledgeTagId})`,
      );
    }
    if (query.errorTypeId) {
      conditions.push(
        sql`exists (select 1 from mistake_record_error_types mret
             where mret.mistake_record_id = mistake_records.id
               and mret.error_type_id = ${query.errorTypeId})`,
      );
    }

    return conditions;
  }

  private selection() {
    return {
      questionId: schema.mistakeRecords.questionId,
      mistakeCount: schema.mistakeRecords.mistakeCount,
      consecutiveCorrect: schema.mistakeRecords.consecutiveCorrect,
      totalAttempts: schema.mistakeRecords.totalAttempts,
      recentAccuracy: schema.mistakeRecords.recentAccuracy,
      masteryState: schema.mistakeRecords.masteryState,
      isResolved: schema.mistakeRecords.isResolved,
      firstMissedAt: schema.mistakeRecords.firstMissedAt,
      lastMissedAt: schema.mistakeRecords.lastMissedAt,
      lastAnsweredAt: schema.mistakeRecords.lastAnsweredAt,
      questionNumber: schema.questions.questionNumber,
      type: schema.questions.type,
      stem: schema.questions.stem,
      explanation: schema.questions.explanation,
      subjectId: schema.questions.subjectId,
      subjectName: schema.subjects.name,
      chapterId: schema.questions.chapterId,
      chapterName: schema.chapters.name,
      questionGroupId: schema.questions.questionGroupId,
      questionGroupName: schema.questionGroups.name,
    };
  }

  private toResponse(row: {
    questionId: string;
    mistakeCount: number;
    consecutiveCorrect: number;
    totalAttempts: number;
    recentAccuracy: string | null;
    masteryState: string;
    isResolved: boolean;
    firstMissedAt: Date | null;
    lastMissedAt: Date | null;
    lastAnsweredAt: Date | null;
    questionNumber: number;
    type: 'single_choice' | 'multiple_choice';
    stem: string;
    subjectId: string;
    subjectName: string;
    chapterId: string | null;
    chapterName: string | null;
    questionGroupId: string;
    questionGroupName: string;
  }): MistakeResponse {
    return {
      questionId: row.questionId,
      questionNumber: row.questionNumber,
      type: row.type,
      stem: row.stem,
      subjectId: row.subjectId,
      subjectName: row.subjectName,
      chapterId: row.chapterId,
      chapterName: row.chapterName,
      questionGroupId: row.questionGroupId,
      questionGroupName: row.questionGroupName,
      mistakeCount: row.mistakeCount,
      consecutiveCorrect: row.consecutiveCorrect,
      totalAttempts: row.totalAttempts,
      recentAccuracy: row.recentAccuracy === null ? null : Number(row.recentAccuracy),
      masteryState: row.masteryState as MistakeResponse['masteryState'],
      isResolved: row.isResolved,
      firstMissedAt: row.firstMissedAt?.toISOString() ?? null,
      lastMissedAt: row.lastMissedAt?.toISOString() ?? null,
      lastAnsweredAt: row.lastAnsweredAt?.toISOString() ?? null,
    };
  }
}
