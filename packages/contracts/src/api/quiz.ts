import { z } from 'zod';

import { MASTERY_STATES } from '../quiz/mastery';
import { paginationQuerySchema, uuidSchema } from './common';
import { optionKeySchema, questionTypeSchema } from './questions';

/**
 * 作答契約。
 *
 * 本檔最重要的設計是「答案只能出現在 `reveal` 這一個欄位裡」。
 *
 * FR-QUIZ-11 要求 `after_submit` 模式在交卷前，回應中不得包含任何正確答案資訊。
 * 如果把 correctAnswers、isCorrect、explanation 散落在回應各處，
 * 之後任何一次改動都可能不小心把某個欄位漏出去，而且很難測。
 * 因此把三者收斂成單一個可為 null 的 `reveal` 物件：
 *   - 契約層一眼就能看出「答案只有一個出口」
 *   - 測試只要斷言 `reveal === null`，再對整個回應做一次深層掃描即可
 */

export const quizModeSchema = z.enum(['practice', 'mistake_review', 'knowledge_focus', 'exam']);
export type QuizMode = z.infer<typeof quizModeSchema>;

export const orderStrategySchema = z.enum(['sequential', 'random']);
export type OrderStrategy = z.infer<typeof orderStrategySchema>;

export const revealModeSchema = z.enum(['immediate', 'after_submit']);
export type RevealMode = z.infer<typeof revealModeSchema>;

export const quizSessionStatusSchema = z.enum(['in_progress', 'submitted', 'abandoned']);
export type QuizSessionStatus = z.infer<typeof quizSessionStatusSchema>;

export const quizSessionQuestionStatusSchema = z.enum(['unanswered', 'answered', 'skipped']);
export type QuizSessionQuestionStatus = z.infer<typeof quizSessionQuestionStatusSchema>;

/**
 * 出題範圍類型。
 *
 * `knowledge_tag` 屬 Phase 3（FR-QUIZ-06），資料庫的 CHECK 已先納入該值，
 * 但 API 目前只接受下列三種，避免宣稱支援尚未實作的功能。
 */
export const quizScopeTypeSchema = z.enum(['subject', 'chapter', 'question_group']);
export type QuizScopeType = z.infer<typeof quizScopeTypeSchema>;

export const quizScopeInputSchema = z
  .object({
    scopeType: quizScopeTypeSchema,
    refId: uuidSchema,
  })
  .strict();
export type QuizScopeInput = z.infer<typeof quizScopeInputSchema>;

export const QUIZ_QUESTION_LIMIT_MAX = 500;

export const createQuizSessionSchema = z
  .object({
    mode: quizModeSchema.default('practice'),
    scopes: z.array(quizScopeInputSchema).max(50).default([]),
    orderStrategy: orderStrategySchema.default('sequential'),
    shuffleOptions: z.boolean().default(false),
    questionLimit: z.number().int().positive().max(QUIZ_QUESTION_LIMIT_MAX).nullish(),
    revealMode: revealModeSchema.default('immediate'),
    allowAnswerChange: z.boolean().default(true),
    /** 只作答錯題（FR-QUIZ-05）。與 scopes 同時給定時取交集。 */
    onlyMistakes: z.boolean().default(false),
    /** 只作答尚未熟練的錯題。僅在 onlyMistakes 為 true 時有意義。 */
    masteryStates: z.array(z.enum(MASTERY_STATES)).max(3).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scopes.length === 0 && !value.onlyMistakes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopes'],
        message: '請至少指定一個出題範圍，或選擇「只作答錯題」',
      });
    }
    if (value.masteryStates.length > 0 && !value.onlyMistakes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['masteryStates'],
        message: '熟練狀態篩選只能搭配「只作答錯題」使用',
      });
    }
  });
export type CreateQuizSessionRequest = z.infer<typeof createQuizSessionSchema>;

export const quizScopeResponseSchema = z.object({
  scopeType: z.enum(['subject', 'chapter', 'question_group', 'knowledge_tag', 'mistake']),
  refId: z.string().uuid().nullable(),
  refName: z.string().nullable(),
});

export const quizSessionResponseSchema = z.object({
  id: z.string().uuid(),
  mode: quizModeSchema,
  orderStrategy: orderStrategySchema,
  shuffleOptions: z.boolean(),
  questionLimit: z.number().int().nullable(),
  revealMode: revealModeSchema,
  allowAnswerChange: z.boolean(),
  status: quizSessionStatusSchema,
  totalQuestions: z.number().int(),
  answeredCount: z.number().int(),
  /**
   * 交卷前的答對題數。
   * `after_submit` 模式在交卷前一律為 null —— 否則使用者只要盯著這個數字，
   * 就能反推剛才那題答對沒有，等同於提前揭露答案。
   */
  correctCount: z.number().int().nullable(),
  score: z.number().nullable(),
  scopes: z.array(quizScopeResponseSchema),
  startedAt: z.string().datetime(),
  submittedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nullable(),
  createdAt: z.string().datetime(),
});
export type QuizSessionResponse = z.infer<typeof quizSessionResponseSchema>;

/** 答案揭露區塊。**整份契約中唯一會出現正確答案的地方。** */
export const quizRevealSchema = z.object({
  isCorrect: z.boolean(),
  correctAnswers: z.array(z.string()),
  /** 題庫原有的解析；沒有就是 null，系統不編造（FR-Q-08）。 */
  explanation: z.string().nullable(),
});
export type QuizReveal = z.infer<typeof quizRevealSchema>;

export const quizAnswerStateSchema = z.object({
  answerId: z.string().uuid(),
  selectedAnswers: z.array(z.string()),
  responseTimeMs: z.number().int().nullable(),
  answerChangedCount: z.number().int(),
  answeredAt: z.string().datetime(),
});

/** 作答中的單題。選項已依 `option_order` 排好，且**不含** isCorrect。 */
export const quizQuestionResponseSchema = z.object({
  sessionQuestionId: z.string().uuid(),
  questionId: z.string().uuid(),
  position: z.number().int(),
  totalQuestions: z.number().int(),
  status: quizSessionQuestionStatusSchema,
  questionNumber: z.number().int(),
  type: questionTypeSchema,
  stem: z.string(),
  options: z.array(z.object({ key: z.string(), text: z.string() })),
  subjectName: z.string(),
  chapterName: z.string().nullable(),
  questionGroupName: z.string(),
  answer: quizAnswerStateSchema.nullable(),
  reveal: quizRevealSchema.nullable(),
});
export type QuizQuestionResponse = z.infer<typeof quizQuestionResponseSchema>;

export const submitAnswerSchema = z
  .object({
    sessionQuestionId: uuidSchema,
    selectedAnswers: z.array(optionKeySchema).min(1, '請至少選擇一個選項').max(10),
    responseTimeMs: z.number().int().nonnegative().max(86_400_000).nullish(),
  })
  .strict();
export type SubmitAnswerRequest = z.infer<typeof submitAnswerSchema>;

export const updateAnswerSchema = submitAnswerSchema.omit({ sessionQuestionId: true }).strict();
export type UpdateAnswerRequest = z.infer<typeof updateAnswerSchema>;

export const submitAnswerResponseSchema = z.object({
  answerId: z.string().uuid(),
  recorded: z.literal(true),
  answeredCount: z.number().int(),
  totalQuestions: z.number().int(),
  /** `after_submit` 模式下永遠是 null。 */
  reveal: quizRevealSchema.nullable(),
});
export type SubmitAnswerResponse = z.infer<typeof submitAnswerResponseSchema>;

export const quizResultItemSchema = z.object({
  position: z.number().int(),
  sessionQuestionId: z.string().uuid(),
  questionId: z.string().uuid(),
  questionNumber: z.number().int(),
  type: questionTypeSchema,
  stem: z.string(),
  options: z.array(z.object({ key: z.string(), text: z.string(), isCorrect: z.boolean() })),
  selectedAnswers: z.array(z.string()).nullable(),
  correctAnswers: z.array(z.string()),
  isCorrect: z.boolean().nullable(),
  explanation: z.string().nullable(),
  responseTimeMs: z.number().int().nullable(),
  subjectName: z.string(),
  chapterName: z.string().nullable(),
  questionGroupName: z.string(),
});
export type QuizResultItem = z.infer<typeof quizResultItemSchema>;

export const quizResultResponseSchema = z.object({
  session: quizSessionResponseSchema,
  totalQuestions: z.number().int(),
  answeredCount: z.number().int(),
  correctCount: z.number().int(),
  incorrectCount: z.number().int(),
  unansweredCount: z.number().int(),
  /** 0～100，答對題數 ÷ 總題數。未作答視同答錯。 */
  score: z.number(),
  accuracy: z.number(),
  durationMs: z.number().int().nullable(),
  averageResponseTimeMs: z.number().int().nullable(),
  items: z.array(quizResultItemSchema),
});
export type QuizResultResponse = z.infer<typeof quizResultResponseSchema>;

export const listQuizSessionsQuerySchema = paginationQuerySchema.extend({
  status: quizSessionStatusSchema.optional(),
  mode: quizModeSchema.optional(),
});
export type ListQuizSessionsQuery = z.infer<typeof listQuizSessionsQuerySchema>;
