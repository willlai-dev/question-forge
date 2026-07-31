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
