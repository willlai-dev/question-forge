import { z } from 'zod';

import { paginationQuerySchema, uuidSchema } from './common';
import { questionTagResponseSchema } from './tags';

/**
 * 題目契約。
 *
 * 題型規則（FR-Q-03）刻意寫在共用 schema 的 superRefine 中，
 * 前端表單與後端驗證因此使用完全同一份規則，不會出現兩邊不一致。
 */

export const questionTypeSchema = z.enum(['single_choice', 'multiple_choice']);
export type QuestionType = z.infer<typeof questionTypeSchema>;

export const questionStatusSchema = z.enum(['active', 'disputed', 'excluded']);
export type QuestionStatus = z.infer<typeof questionStatusSchema>;

export const optionKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]$/, '選項代號必須是單一大寫英文字母');

export const optionInputSchema = z
  .object({
    key: optionKeySchema,
    text: z.string().trim().min(1, '選項內容不可為空').max(2000),
    isCorrect: z.boolean(),
  })
  .strict();
export type OptionInput = z.infer<typeof optionInputSchema>;

const questionBodySchema = z.object({
  questionGroupId: uuidSchema,
  questionNumber: z.number().int().positive('題號必須是正整數'),
  type: questionTypeSchema,
  stem: z.string().trim().min(1, '題幹不可為空').max(8000),
  options: z.array(optionInputSchema).min(2, '至少需要兩個選項').max(10),
  /** 允許為空。系統絕不自動編造解析（FR-Q-08）。 */
  explanation: z.string().trim().max(8000).nullish(),
  sourcePage: z.number().int().positive('頁碼必須是正整數').nullish(),
  sourceReference: z.string().trim().max(300).nullish(),
  reviewRequired: z.boolean().default(false),
  reviewReason: z.string().trim().max(1000).nullish(),
});

/** 選項與答案的跨欄位規則，供建立與更新共用。 */
export function refineQuestionRules(
  value: { type: QuestionType; options: OptionInput[] },
  ctx: z.RefinementCtx,
): void {
  const keys = value.options.map((o) => o.key);
  const duplicated = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (duplicated.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: `選項代號重複：${[...new Set(duplicated)].join('、')}`,
    });
  }

  const correctCount = value.options.filter((o) => o.isCorrect).length;

  if (value.type === 'single_choice' && correctCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: `單選題必須恰好一個正確答案，目前有 ${correctCount} 個`,
    });
  }

  if (value.type === 'multiple_choice' && correctCount < 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: `複選題至少需要兩個正確答案，目前有 ${correctCount} 個`,
    });
  }
}

export const createQuestionSchema = questionBodySchema.strict().superRefine(refineQuestionRules);
export type CreateQuestionRequest = z.infer<typeof createQuestionSchema>;

/** 更新時題組不可直接改（改題組請用 bulk move，會一併維護反正規化欄位）。 */
export const updateQuestionSchema = questionBodySchema
  .omit({ questionGroupId: true })
  .strict()
  .superRefine(refineQuestionRules);
export type UpdateQuestionRequest = z.infer<typeof updateQuestionSchema>;

export const optionResponseSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  text: z.string(),
  isCorrect: z.boolean(),
  sortOrder: z.number().int(),
});

export const questionResponseSchema = z.object({
  id: z.string().uuid(),
  questionGroupId: z.string().uuid(),
  questionGroupName: z.string(),
  subjectId: z.string().uuid(),
  subjectName: z.string(),
  chapterId: z.string().uuid().nullable(),
  chapterName: z.string().nullable(),
  externalId: z.string().nullable(),
  questionNumber: z.number().int(),
  type: questionTypeSchema,
  stem: z.string(),
  options: z.array(optionResponseSchema),
  explanation: z.string().nullable(),
  sourcePage: z.number().int().nullable(),
  sourceReference: z.string().nullable(),
  reviewRequired: z.boolean(),
  reviewReason: z.string().nullable(),
  status: questionStatusSchema,
  currentVersion: z.number().int(),
  contentHash: z.string(),
  /**
   * 標籤不列入 contentHash，也不會遞增 currentVersion ——
   * 它們是對題目的標註，不是題目內容。改標籤因此不會讓 AI 分析快取失效。
   */
  knowledgeTags: z.array(questionTagResponseSchema).default([]),
  skillTags: z.array(questionTagResponseSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type QuestionResponse = z.infer<typeof questionResponseSchema>;

export const listQuestionsQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  subjectId: uuidSchema.optional(),
  chapterId: z.union([uuidSchema, z.literal('none')]).optional(),
  questionGroupId: uuidSchema.optional(),
  type: questionTypeSchema.optional(),
  status: questionStatusSchema.optional(),
  reviewRequired: z.enum(['true', 'false']).optional(),
  hasExplanation: z.enum(['true', 'false']).optional(),
  /** 只找掛了這個知識點的題目；'none' 代表只找完全沒有知識點的題目。 */
  knowledgeTagId: z.union([uuidSchema, z.literal('none')]).optional(),
  sort: z.enum(['number', 'created', 'updated']).default('number'),
  order: z.enum(['asc', 'desc']).default('asc'),
});
export type ListQuestionsQuery = z.infer<typeof listQuestionsQuerySchema>;

/** 批次操作（FR-Q-06）。 */
export const bulkQuestionActionSchema = z
  .object({
    questionIds: z.array(uuidSchema).min(1, '至少選擇一題').max(500),
    action: z.enum(['move', 'delete', 'setReviewRequired']),
    targetQuestionGroupId: uuidSchema.optional(),
    reviewRequired: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === 'move' && !value.targetQuestionGroupId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetQuestionGroupId'],
        message: '移動題目時必須指定目標題組',
      });
    }
    if (value.action === 'setReviewRequired' && value.reviewRequired === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewRequired'],
        message: '必須指定 reviewRequired 的值',
      });
    }
  });
export type BulkQuestionAction = z.infer<typeof bulkQuestionActionSchema>;

export const questionVersionResponseSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int(),
  contentHash: z.string(),
  changedFields: z.array(z.string()).nullable(),
  changeReason: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type QuestionVersionResponse = z.infer<typeof questionVersionResponseSchema>;
