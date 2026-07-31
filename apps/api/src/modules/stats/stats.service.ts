import { Inject, Injectable } from '@nestjs/common';
import type { StatsOverviewResponse } from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { DATABASE } from '../../infra/infra.module';

/** 近期場次顯示筆數。 */
const RECENT_SESSION_LIMIT = 5;

/**
 * 學習概況統計（FR-QUIZ-09）。
 *
 * 所有正確率相關數字都排除 `is_provisional = true` 的作答（FR-QUIZ-14）。
 * 該欄位在 Phase 2 就存在且預設為 false，因此現在的結果不受影響，
 * 而 Phase 4 開始標記爭議題時，統計會自動正確，不需要回頭改這裡。
 */
@Injectable()
export class StatsService {
  constructor(@Inject(DATABASE) private readonly database: DatabaseHandle) {}

  async overview(userId: string): Promise<StatsOverviewResponse> {
    const { db } = this.database;
    const diagnostic = and(
      eq(schema.userAnswers.userId, userId),
      eq(schema.userAnswers.isProvisional, false),
    );

    const [bank] = await db
      .select({
        subjectCount: sql<number>`count(distinct ${schema.subjects.id})::int`,
      })
      .from(schema.subjects)
      .where(and(eq(schema.subjects.userId, userId), isNull(schema.subjects.deletedAt)));

    const [groups] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.questionGroups)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questionGroups.subjectId))
      .where(and(eq(schema.subjects.userId, userId), isNull(schema.questionGroups.deletedAt)));

    const [questions] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.questions)
      .where(and(eq(schema.questions.userId, userId), isNull(schema.questions.deletedAt)));

    const [sessions] = await db
      .select({
        total: sql<number>`count(*)::int`,
        submitted: sql<number>`count(*) filter (where ${schema.quizSessions.status} = 'submitted')::int`,
        inProgress: sql<number>`count(*) filter (where ${schema.quizSessions.status} = 'in_progress')::int`,
      })
      .from(schema.quizSessions)
      .where(eq(schema.quizSessions.userId, userId));

    const [answers] = await db
      .select({
        answered: sql<number>`count(*)::int`,
        correct: sql<number>`count(*) filter (where ${schema.userAnswers.isCorrect})::int`,
        avgTime: sql<number | null>`avg(${schema.userAnswers.responseTimeMs})::int`,
      })
      .from(schema.userAnswers)
      .where(diagnostic);

    const [mistakes] = await db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${schema.mistakeRecords.masteryState} = 'active')::int`,
        improving: sql<number>`count(*) filter (where ${schema.mistakeRecords.masteryState} = 'improving')::int`,
        mastered: sql<number>`count(*) filter (where ${schema.mistakeRecords.masteryState} = 'mastered')::int`,
      })
      .from(schema.mistakeRecords)
      .where(eq(schema.mistakeRecords.userId, userId));

    const recentSessions = await db
      .select()
      .from(schema.quizSessions)
      .where(eq(schema.quizSessions.userId, userId))
      .orderBy(desc(schema.quizSessions.startedAt), desc(schema.quizSessions.id))
      .limit(RECENT_SESSION_LIMIT);

    const bySubject = await db
      .select({
        subjectId: schema.subjects.id,
        subjectName: schema.subjects.name,
        answeredCount: sql<number>`count(*)::int`,
        correctCount: sql<number>`count(*) filter (where ${schema.userAnswers.isCorrect})::int`,
      })
      .from(schema.userAnswers)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.userAnswers.questionId))
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questions.subjectId))
      .where(diagnostic)
      .groupBy(schema.subjects.id, schema.subjects.name)
      .orderBy(desc(sql`count(*)`));

    const answeredCount = answers?.answered ?? 0;
    const correctCount = answers?.correct ?? 0;

    return {
      subjectCount: bank?.subjectCount ?? 0,
      questionGroupCount: groups?.total ?? 0,
      questionCount: questions?.total ?? 0,

      sessionCount: sessions?.total ?? 0,
      submittedSessionCount: sessions?.submitted ?? 0,
      inProgressSessionCount: sessions?.inProgress ?? 0,
      answeredCount,
      correctCount,
      accuracy: percent(correctCount, answeredCount),
      averageResponseTimeMs: answers?.avgTime ?? null,

      mistakeTotal: mistakes?.total ?? 0,
      mistakeActive: mistakes?.active ?? 0,
      mistakeImproving: mistakes?.improving ?? 0,
      mistakeMastered: mistakes?.mastered ?? 0,

      recentSessions: recentSessions.map((row) => ({
        id: row.id,
        mode: row.mode as StatsOverviewResponse['recentSessions'][number]['mode'],
        status: row.status as StatsOverviewResponse['recentSessions'][number]['status'],
        totalQuestions: row.totalQuestions,
        answeredCount: row.answeredCount,
        // 與場次回應一致：after_submit 模式在交卷前不透露答對題數。
        correctCount:
          row.status !== 'in_progress' || row.revealMode === 'immediate' ? row.correctCount : null,
        score: row.score === null ? null : Number(row.score),
        startedAt: row.startedAt.toISOString(),
        submittedAt: row.submittedAt?.toISOString() ?? null,
      })),
      bySubject: bySubject.map((row) => ({
        ...row,
        accuracy: percent(row.correctCount, row.answeredCount),
      })),
    };
  }
}

/** 百分比，取到小數第二位；分母為 0 時回 null 而不是 0 —— 沒作答不等於 0 分。 */
function percent(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10000) / 100;
}
