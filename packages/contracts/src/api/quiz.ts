import { z } from 'zod';

import { MASTERY_STATES } from '../quiz/mastery';
import { paginationQuerySchema, uuidSchema } from './common';
import { optionKeySchema, questionMarkSchema, questionTypeSchema } from './questions';

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

/** 出題範圍類型。多個範圍之間取聯集。 */
export const quizScopeTypeSchema = z.enum([
  'subject',
  'chapter',
  'question_group',
  /** 只作答特定知識點（FR-QUIZ-06）。 */
  'knowledge_tag',
]);
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
  /**
   * 這題的答案正在爭議待審（`questions.status = 'disputed'`），因此本次作答是暫記的，
   * 不計入能力診斷（FR-QUIZ-14）。
   *
   * 少了這個欄位，畫面只能拿 `isCorrect` 直接告訴使用者「你答錯了」——
   * 但那個判定是拿一個**系統自己都認為可能有誤**的答案算出來的。
   */
  isProvisional: z.boolean(),
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
  /**
   * 個人標記與註記。
   *
   * 與答案揭露無關，因此**不受 revealMode 限制**——標記自己的想法不會洩漏答案，
   * 而交卷前正是最想標記的時刻。
   */
  mark: questionMarkSchema.nullable(),
});
export type QuizQuestionResponse = z.infer<typeof quizQuestionResponseSchema>;

/**
 * 場次題目導覽的單一項目，供跳題選單使用。
 *
 * **不含選項與正確答案。** `isCorrect` 沿用與單題端點完全相同的揭露判準
 * （後端 `canReveal()`）：after_submit 模式交卷前一律為 null。
 * 少了這個限制，使用者只要打開導覽列就能看到每一題的對錯，
 * 等於繞過 FR-QUIZ-11——而且是比單題端點更嚴重的洩漏，因為一次全看見。
 */
export const quizOutlineItemSchema = z.object({
  sessionQuestionId: z.string().uuid(),
  questionId: z.string().uuid(),
  position: z.number().int(),
  questionNumber: z.number().int(),
  type: questionTypeSchema,
  /** 題幹前段，只夠認出是哪一題。 */
  stemPreview: z.string(),
  answered: z.boolean(),
  /** 尚未揭露時為 null——「還不能說」與「答錯了」不可以塌縮成同一個值。 */
  isCorrect: z.boolean().nullable(),
  /** 這題的答案爭議待審，作答為暫記、不計入診斷。 */
  isProvisional: z.boolean(),
  /** 自己標為重點。導覽列據此標出來，才找得回剛才標的那幾題。 */
  isFlagged: z.boolean(),
});
export type QuizOutlineItem = z.infer<typeof quizOutlineItemSchema>;

export const quizOutlineResponseSchema = z.object({
  totalQuestions: z.number().int(),
  items: z.array(quizOutlineItemSchema),
});
export type QuizOutlineResponse = z.infer<typeof quizOutlineResponseSchema>;

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
  /**
   * `isCorrect` 為 null 代表「這一題還不該揭曉」——不是「這個選項不是答案」。
   * 用 false 代替 null 等於說謊：前端無法分辨「已知是錯的」與「還不知道」。
   */
  options: z.array(
    z.object({ key: z.string(), text: z.string(), isCorrect: z.boolean().nullable() }),
  ),
  selectedAnswers: z.array(z.string()).nullable(),
  /**
   * 這一題的作答 ID。沒作答時為 null。
   * 用來讓結果頁的 AI 解析能帶上「使用者選了什麼」，產生個人化的錯因分析——
   * 少了它只能得到題目層級的通用解析。
   */
  answerId: z.string().uuid().nullable(),
  /** 同上：尚未揭曉時為 null，而不是空陣列。 */
  correctAnswers: z.array(z.string()).nullable(),
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
