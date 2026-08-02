import { z } from 'zod';

import { quizModeSchema, quizSessionStatusSchema } from './quiz';

/**
 * 學習概況統計（FR-QUIZ-09）。
 *
 * 所有正確率相關數字一律排除 `is_provisional = true` 的作答 ——
 * 那是 Phase 4 答案爭議待審期間的作答，不應計入能力診斷（FR-QUIZ-14）。
 * 條件現在就寫進查詢，Phase 4 不必回頭改統計。
 */

export const recentSessionSchema = z.object({
  id: z.string().uuid(),
  mode: quizModeSchema,
  status: quizSessionStatusSchema,
  totalQuestions: z.number().int(),
  answeredCount: z.number().int(),
  correctCount: z.number().int().nullable(),
  score: z.number().nullable(),
  startedAt: z.string().datetime(),
  submittedAt: z.string().datetime().nullable(),
});

export const statsOverviewResponseSchema = z.object({
  /** 題庫規模。 */
  subjectCount: z.number().int(),
  questionGroupCount: z.number().int(),
  questionCount: z.number().int(),

  /** 作答概況。 */
  sessionCount: z.number().int(),
  submittedSessionCount: z.number().int(),
  inProgressSessionCount: z.number().int(),
  answeredCount: z.number().int(),
  correctCount: z.number().int(),
  accuracy: z.number().nullable(),
  averageResponseTimeMs: z.number().int().nullable(),

  /** 錯題概況。 */
  mistakeTotal: z.number().int(),
  mistakeActive: z.number().int(),
  mistakeImproving: z.number().int(),
  mistakeMastered: z.number().int(),

  recentSessions: z.array(recentSessionSchema),
  bySubject: z.array(
    z.object({
      subjectId: z.string().uuid(),
      subjectName: z.string(),
      answeredCount: z.number().int(),
      correctCount: z.number().int(),
      accuracy: z.number().nullable(),
    }),
  ),
});
export type StatsOverviewResponse = z.infer<typeof statsOverviewResponseSchema>;

// ---------------------------------------------------------------- 多題整合分析的統計

/**
 * 多題分析的統計輸入（規格 §11、FR-AGG-01～02）。
 *
 * 規格明訂「不應直接將所有完整題目一次傳給模型」，因此送進 prompt 的是這一份
 * **結構化數字**加上最多 15 題的代表錯題摘要，而不是題庫原文。
 *
 * 所有由 `user_answers` 推導的數字都套用共用的診斷判準：
 * 排除暫記作答、軟刪除題目，以及爭議中／已排除的題目。
 */

const bucketSchema = z.object({
  id: z.string(),
  name: z.string(),
  answered: z.number().int(),
  correct: z.number().int(),
  /** 0～100。分母為 0 時為 null —— 沒作答不等於 0 分。 */
  accuracy: z.number().nullable(),
});

export const aggregateTrendVerdictSchema = z.enum([
  'improved',
  'not_improved',
  'stable_ok',
  'insufficient',
]);

export const aggregateStatsSchema = z.object({
  period: z.object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    /** 前後半段的分界點。趨勢數字全部切在這一刻，讓結論可重現。 */
    mid: z.string().datetime(),
    generatedAt: z.string().datetime(),
  }),

  overall: z.object({
    totalAnswered: z.number().int(),
    correct: z.number().int(),
    accuracy: z.number().nullable(),
    avgResponseTimeMs: z.number().int().nullable(),
    /** 有填作答時間的筆數。作答時間可為 null，只看平均會誤判樣本量。 */
    responseTimeSamples: z.number().int(),
  }),

  bySubject: z.array(bucketSchema),
  byChapter: z.array(bucketSchema),
  byQuestionGroup: z.array(bucketSchema),

  byKnowledgeTag: z.array(
    bucketSchema.extend({
      /** 以主要知識點身分被作答的筆數。全靠次要身分累積的標籤，證據力較弱。 */
      primaryAnswered: z.number().int(),
      /** 後半段減前半段，單位百分點。資料不足時為 null。 */
      trend: z.number().nullable(),
      trendVerdict: aggregateTrendVerdictSchema,
    }),
  ),

  /**
   * 一筆作答若掛 1 主 2 次知識點，會在三個標籤桶各算一次 —— 這對「單一標籤的正確率」
   * 是正確的，但代表 byKnowledgeTag 的加總必然大於 overall。這個欄位讓扇出程度看得見，
   * 也讓「只有一成作答有標籤」這件事不會被藏起來。
   */
  knowledgeTagCoverage: z.object({
    taggedAnswered: z.number().int(),
    totalAnswered: z.number().int(),
  }),

  byErrorType: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      count: z.number().int(),
      questionCount: z.number().int(),
    }),
  ),
  /**
   * 錯誤類型是**終身**統計而非期間統計：來源資料表沒有逐次發生的時間戳。
   * 明講出來，避免模型拿累計數字寫成「這個月你最常犯的是⋯」。
   */
  errorTypeWindow: z.literal('lifetime'),

  consecutiveWrongStreaks: z.array(
    z.object({
      knowledgeTagId: z.string(),
      knowledgeTagName: z.string(),
      streak: z.number().int(),
    }),
  ),

  recentAccuracyChange: z.object({
    previousAnswered: z.number().int(),
    previous: z.number().nullable(),
    currentAnswered: z.number().int(),
    current: z.number().nullable(),
    delta: z.number().nullable(),
    verdict: aggregateTrendVerdictSchema,
  }),

  improved: z.array(z.string()),
  notImproved: z.array(z.string()),
});
export type AggregateStats = z.infer<typeof aggregateStatsSchema>;

export const representativeQuestionSchema = z.object({
  questionId: z.string().uuid(),
  questionNumber: z.number().int(),
  stem: z.string(),
  subjectName: z.string(),
  knowledgeTagNames: z.array(z.string()),
  errorTypeCodes: z.array(z.string()),
  wrongCount: z.number().int(),
  attemptCount: z.number().int(),
  lastSelectedAnswers: z.array(z.string()),
  correctAnswers: z.array(z.string()),
  score: z.number().int(),
  reasons: z.array(z.string()),
});
export type RepresentativeQuestion = z.infer<typeof representativeQuestionSchema>;

export const aggregateStatsResponseSchema = z.object({
  stats: aggregateStatsSchema,
  representativeQuestions: z.array(representativeQuestionSchema),
});
export type AggregateStatsResponse = z.infer<typeof aggregateStatsResponseSchema>;

/** 統計查詢的期間。省略則預設為最近 30 天。 */
export const AGGREGATE_DEFAULT_PERIOD_DAYS = 30;

export const aggregateStatsQuerySchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .refine(
    (value) => !value.from || !value.to || new Date(value.from) < new Date(value.to),
    { message: 'from 必須早於 to。', path: ['from'] },
  );
export type AggregateStatsQuery = z.infer<typeof aggregateStatsQuerySchema>;
