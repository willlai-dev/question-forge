import { z } from 'zod';

import { paginationQuerySchema, uuidSchema } from './common';
import { questionTagResponseSchema, SECONDARY_KNOWLEDGE_TAG_MAX } from './tags';

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

/**
 * 單題的個人標記。
 *
 * 與 `reviewRequired` 是兩件事：後者是「這道題目本身需要人工複核」（題庫品質），
 * 這裡是「我覺得這題重要」（個人學習）。混在一起之後就再也分不開。
 */
export const questionMarkSchema = z.object({
  isFlagged: z.boolean(),
  note: z.string().nullable(),
  updatedAt: z.string().datetime(),
});
export type QuestionMark = z.infer<typeof questionMarkSchema>;

/** 設定標記。兩個欄位都省略等於沒有變更；都清空則整筆標記會被移除。 */
export const setQuestionMarkSchema = z
  .object({
    isFlagged: z.boolean().optional(),
    note: z.string().trim().max(2000).nullish(),
  })
  .strict();
export type SetQuestionMarkRequest = z.infer<typeof setQuestionMarkSchema>;

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
  /** 個人標記；沒有標記過就是 null。 */
  mark: questionMarkSchema.nullable().default(null),
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
  /** 只找自己標為重點的題目。 */
  flagged: z.enum(['true', 'false']).optional(),
  sort: z.enum(['number', 'created', 'updated']).default('number'),
  order: z.enum(['asc', 'desc']).default('asc'),
});
export type ListQuestionsQuery = z.infer<typeof listQuestionsQuerySchema>;

/** 批次操作（FR-Q-06）。 */
export const bulkQuestionActionSchema = z
  .object({
    questionIds: z.array(uuidSchema).min(1, '至少選擇一題').max(500),
    action: z.enum(['move', 'delete', 'setReviewRequired', 'setKnowledgeTags']),
    targetQuestionGroupId: uuidSchema.optional(),
    reviewRequired: z.boolean().optional(),
    /**
     * 批次貼標籤用。語意是**取代**：把選中題目的知識點整組換成這裡指定的，
     * 不是疊加。疊加會讓「主要知識點最多一個」的規則在批次情境下無從判斷該保留誰。
     */
    primaryKnowledgeTagId: uuidSchema.nullish(),
    secondaryKnowledgeTagIds: z.array(uuidSchema).max(SECONDARY_KNOWLEDGE_TAG_MAX).optional(),
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
    if (value.action === 'setKnowledgeTags') {
      const secondary = value.secondaryKnowledgeTagIds ?? [];
      if (new Set(secondary).size !== secondary.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['secondaryKnowledgeTagIds'],
          message: '次要知識點不可重複',
        });
      }
      if (value.primaryKnowledgeTagId && secondary.includes(value.primaryKnowledgeTagId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['secondaryKnowledgeTagIds'],
          message: '次要知識點不可與主要知識點相同',
        });
      }
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
