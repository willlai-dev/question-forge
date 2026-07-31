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
      .select(this.selection())
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
          eq(schema.mistakeRecords.userId, userId),
          eq(schema.mistakeRecords.questionId, questionId),
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

    const attempts = await db
      .select()
      .from(schema.userAnswers)
      .where(
        and(
          eq(schema.userAnswers.userId, userId),
          eq(schema.userAnswers.questionId, questionId),
        ),
      )
      .orderBy(desc(schema.userAnswers.answeredAt));

    return {
      ...this.toResponse(row),
      options: options.map((o) => ({ key: o.key, text: o.text, isCorrect: o.isCorrect })),
      correctAnswers: options.filter((o) => o.isCorrect).map((o) => o.key),
      explanation: row.explanation,
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
      .where(eq(schema.mistakeRecords.userId, userId));

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
      .where(eq(schema.mistakeRecords.userId, userId))
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
    const scopes: { scopeType: 'subject' | 'chapter' | 'question_group'; refId: string }[] = [];
    if (dto.questionGroupId)
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
    const conditions: SQL[] = [
      eq(schema.mistakeRecords.userId, userId),
      // 題目被軟刪除後，錯題紀錄保留但不再列出 —— 紀錄不刪除，只是沒有東西可以複習。
      isNull(schema.questions.deletedAt),
    ];
    if (query.subjectId) conditions.push(eq(schema.questions.subjectId, query.subjectId));
    if (query.chapterId === 'none') conditions.push(isNull(schema.questions.chapterId));
    else if (query.chapterId) conditions.push(eq(schema.questions.chapterId, query.chapterId));
    if (query.questionGroupId)
      conditions.push(eq(schema.questions.questionGroupId, query.questionGroupId));
    if (query.masteryState)
      conditions.push(eq(schema.mistakeRecords.masteryState, query.masteryState));
    if (query.isResolved)
      conditions.push(eq(schema.mistakeRecords.isResolved, query.isResolved === 'true'));
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
