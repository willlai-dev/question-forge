import { Inject, Injectable } from '@nestjs/common';
import { percent, type StatsOverviewResponse } from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import { diagnosticMistakeScope, diagnosticScope } from '../../common/diagnostic-scope';
import { DATABASE } from '../../infra/infra.module';

/** 近期場次顯示筆數。 */
const RECENT_SESSION_LIMIT = 5;

/**
 * 學習概況統計（FR-QUIZ-09）。
 *
 * 所有診斷相關數字都走 `common/diagnostic-scope` 的共用判準：
 * 排除暫記作答（FR-QUIZ-14）、軟刪除題目，以及爭議中／已排除的題目（驗收 #18）。
 *
 * 這裡曾經只過濾 `is_provisional`，導致本頁的錯題總數與 `/mistakes/stats`
 * 對不起來——同一個使用者、同一份資料，兩個畫面給出不同答案。
 * 判準現在只有一份，兩邊都用它。
 */
@Injectable()
export class StatsService {
  constructor(@Inject(DATABASE) private readonly database: DatabaseHandle) {}

  async overview(userId: string): Promise<StatsOverviewResponse> {
    const { db } = this.database;
    const diagnostic = diagnosticScope(userId);

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

    // 這兩支都必須 join questions —— 判準要看題目的 deleted_at 與 status。
    const [answers] = await db
      .select({
        answered: sql<number>`count(*)::int`,
        correct: sql<number>`count(*) filter (where ${schema.userAnswers.isCorrect})::int`,
        avgTime: sql<number | null>`avg(${schema.userAnswers.responseTimeMs})::int`,
      })
      .from(schema.userAnswers)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.userAnswers.questionId))
      .where(diagnostic);

    const [mistakes] = await db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${schema.mistakeRecords.masteryState} = 'active')::int`,
        improving: sql<number>`count(*) filter (where ${schema.mistakeRecords.masteryState} = 'improving')::int`,
        mastered: sql<number>`count(*) filter (where ${schema.mistakeRecords.masteryState} = 'mastered')::int`,
      })
      .from(schema.mistakeRecords)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.mistakeRecords.questionId))
      .where(diagnosticMistakeScope(userId));

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
      // 名稱是必要的平手條件：只依 count 排序時，數量相同的科目順序由資料庫決定，
      // 同一份資料可能每次回傳不同順序。
      .orderBy(desc(sql`count(*)`), asc(schema.subjects.name));

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
