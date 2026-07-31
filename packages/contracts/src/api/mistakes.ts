import { z } from 'zod';

import { MASTERY_STATES } from '../quiz/mastery';
import { paginationQuerySchema, uuidSchema } from './common';
import { orderStrategySchema, revealModeSchema, QUIZ_QUESTION_LIMIT_MAX } from './quiz';
import { questionTypeSchema } from './questions';

/**
 * 錯題本契約。
 *
 * 錯題紀錄一旦建立就永遠保留（FR-MIS-05），答對只會改變 `masteryState`。
 * 所以這裡沒有任何刪除端點 —— 這是刻意的，不是漏掉。
 */

export const masteryStateSchema = z.enum(MASTERY_STATES);
export type MasteryStateValue = z.infer<typeof masteryStateSchema>;

export const listMistakesQuerySchema = paginationQuerySchema.extend({
  subjectId: uuidSchema.optional(),
  chapterId: z.union([uuidSchema, z.literal('none')]).optional(),
  questionGroupId: uuidSchema.optional(),
  masteryState: masteryStateSchema.optional(),
  isResolved: z.enum(['true', 'false']).optional(),
  sort: z.enum(['lastMissed', 'mistakeCount', 'accuracy']).default('lastMissed'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type ListMistakesQuery = z.infer<typeof listMistakesQuerySchema>;

export const mistakeResponseSchema = z.object({
  questionId: z.string().uuid(),
  questionNumber: z.number().int(),
  type: questionTypeSchema,
  stem: z.string(),
  subjectId: z.string().uuid(),
  subjectName: z.string(),
  chapterId: z.string().uuid().nullable(),
  chapterName: z.string().nullable(),
  questionGroupId: z.string().uuid(),
  questionGroupName: z.string(),
  mistakeCount: z.number().int(),
  consecutiveCorrect: z.number().int(),
  totalAttempts: z.number().int(),
  recentAccuracy: z.number().nullable(),
  masteryState: masteryStateSchema,
  /** 是否曾經重新答對過。不會因為之後又答錯而變回 false。 */
  isResolved: z.boolean(),
  firstMissedAt: z.string().datetime().nullable(),
  lastMissedAt: z.string().datetime().nullable(),
  lastAnsweredAt: z.string().datetime().nullable(),
});
export type MistakeResponse = z.infer<typeof mistakeResponseSchema>;

export const mistakeAttemptSchema = z.object({
  answerId: z.string().uuid(),
  quizSessionId: z.string().uuid(),
  selectedAnswers: z.array(z.string()),
  correctAnswers: z.array(z.string()),
  isCorrect: z.boolean(),
  responseTimeMs: z.number().int().nullable(),
  revealMode: revealModeSchema,
  questionVersion: z.number().int(),
  answeredAt: z.string().datetime(),
});
export type MistakeAttempt = z.infer<typeof mistakeAttemptSchema>;

export const mistakeDetailResponseSchema = mistakeResponseSchema.extend({
  options: z.array(z.object({ key: z.string(), text: z.string(), isCorrect: z.boolean() })),
  correctAnswers: z.array(z.string()),
  explanation: z.string().nullable(),
  attempts: z.array(mistakeAttemptSchema),
});
export type MistakeDetailResponse = z.infer<typeof mistakeDetailResponseSchema>;

export const mistakeStatsResponseSchema = z.object({
  total: z.number().int(),
  active: z.number().int(),
  improving: z.number().int(),
  mastered: z.number().int(),
  resolved: z.number().int(),
  bySubject: z.array(
    z.object({
      subjectId: z.string().uuid(),
      subjectName: z.string(),
      total: z.number().int(),
      active: z.number().int(),
      mastered: z.number().int(),
    }),
  ),
});
export type MistakeStatsResponse = z.infer<typeof mistakeStatsResponseSchema>;

/** 直接從錯題本篩選條件建立重練場次（FR-MIS-04）。 */
export const createMistakePracticeSchema = z
  .object({
    subjectId: uuidSchema.optional(),
    chapterId: z.union([uuidSchema, z.literal('none')]).optional(),
    questionGroupId: uuidSchema.optional(),
    masteryStates: z.array(masteryStateSchema).max(3).default([]),
    questionLimit: z.number().int().positive().max(QUIZ_QUESTION_LIMIT_MAX).nullish(),
    orderStrategy: orderStrategySchema.default('random'),
    shuffleOptions: z.boolean().default(true),
    revealMode: revealModeSchema.default('immediate'),
    allowAnswerChange: z.boolean().default(true),
  })
  .strict();
export type CreateMistakePracticeRequest = z.infer<typeof createMistakePracticeSchema>;
