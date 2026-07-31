import { z } from 'zod';

import { paginationQuerySchema, uuidSchema } from './common';

/**
 * 受控標籤契約（規格 §8）。
 *
 * 三類詞彙：知識點（使用者自建）、能力類型與錯誤類型（系統預設種子資料）。
 * **AI 只能從既有標籤中挑選**，找不到適合者只能提交 `tag_suggestions`（FR-TAG-06），
 * 因此本檔案沒有任何「由 AI 直接建立標籤」的入口 —— 這是刻意的，不是遺漏。
 */

export const tagKindSchema = z.enum(['knowledge', 'skill', 'error_type']);
export type TagKind = z.infer<typeof tagKindSchema>;

export const tagStatusSchema = z.enum(['active', 'deprecated', 'merged']);
export type TagStatus = z.infer<typeof tagStatusSchema>;

export const tagRoleSchema = z.enum(['primary', 'secondary']);
export type TagRole = z.infer<typeof tagRoleSchema>;

export const tagSourceSchema = z.enum(['manual', 'ai', 'import']);
export type TagSource = z.infer<typeof tagSourceSchema>;

/** 每題次要知識點上限（FR-TAG-02）。 */
export const SECONDARY_KNOWLEDGE_TAG_MAX = 2;
/** 每題次要能力類型上限。主要 1 個由資料庫部分唯一索引保證（FR-TAG-03）。 */
export const SECONDARY_SKILL_TAG_MAX = 3;

const tagNameSchema = z.string().trim().min(1, '名稱不可為空').max(100, '名稱最多 100 個字元');

// ---------------------------------------------------------------- 知識點

export const createKnowledgeTagSchema = z
  .object({
    name: tagNameSchema,
    /** 可限定科目範圍；null 代表跨科目通用。 */
    subjectId: uuidSchema.nullish(),
    description: z.string().trim().max(1000).nullish(),
    parentId: uuidSchema.nullish(),
  })
  .strict();
export type CreateKnowledgeTagRequest = z.infer<typeof createKnowledgeTagSchema>;

export const updateKnowledgeTagSchema = createKnowledgeTagSchema.partial().strict();
export type UpdateKnowledgeTagRequest = z.infer<typeof updateKnowledgeTagSchema>;

export const knowledgeTagResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  subjectId: z.string().uuid().nullable(),
  subjectName: z.string().nullable(),
  description: z.string().nullable(),
  parentId: z.string().uuid().nullable(),
  parentName: z.string().nullable(),
  status: tagStatusSchema,
  mergedIntoId: z.string().uuid().nullable(),
  mergedIntoName: z.string().nullable(),
  /** 目前掛在這個標籤上的題目數。合併與停用前用來提醒影響範圍。 */
  usageCount: z.number().int(),
  aliases: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type KnowledgeTagResponse = z.infer<typeof knowledgeTagResponseSchema>;

export const listKnowledgeTagsQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  subjectId: z.union([uuidSchema, z.literal('none')]).optional(),
  status: tagStatusSchema.optional(),
});
export type ListKnowledgeTagsQuery = z.infer<typeof listKnowledgeTagsQuerySchema>;

export const mergeTagSchema = z
  .object({
    targetTagId: uuidSchema,
  })
  .strict();
export type MergeTagRequest = z.infer<typeof mergeTagSchema>;

// ---------------------------------------------------------------- 能力類型

export const createSkillTagSchema = z
  .object({
    name: tagNameSchema,
    description: z.string().trim().max(1000).nullish(),
  })
  .strict();
export type CreateSkillTagRequest = z.infer<typeof createSkillTagSchema>;

export const updateSkillTagSchema = z
  .object({
    name: tagNameSchema.optional(),
    description: z.string().trim().max(1000).nullish(),
    sortOrder: z.number().int().min(0).optional(),
    status: z.enum(['active', 'deprecated']).optional(),
  })
  .strict();
export type UpdateSkillTagRequest = z.infer<typeof updateSkillTagSchema>;

export const skillTagResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  sortOrder: z.number().int(),
  status: tagStatusSchema,
  usageCount: z.number().int(),
  aliases: z.array(z.string()),
});
export type SkillTagResponse = z.infer<typeof skillTagResponseSchema>;

// ---------------------------------------------------------------- 錯誤類型

/**
 * 錯誤類型不提供新增與刪除端點：這是一組固定的診斷詞彙，
 * 由種子資料建立，使用者只能改名或停用。
 * 若允許自由新增，AI 的錯因判斷就會失去可比較性。
 */
export const updateErrorTypeSchema = z
  .object({
    name: tagNameSchema.optional(),
    description: z.string().trim().max(1000).nullish(),
    sortOrder: z.number().int().min(0).optional(),
    status: z.enum(['active', 'deprecated']).optional(),
  })
  .strict();
export type UpdateErrorTypeRequest = z.infer<typeof updateErrorTypeSchema>;

export const errorTypeResponseSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sortOrder: z.number().int(),
  status: tagStatusSchema,
  /** 「無法判定」。AI 判斷不出錯因時必須有合法選項可選，否則會被迫亂猜。 */
  isFallback: z.boolean(),
  usageCount: z.number().int(),
});
export type ErrorTypeResponse = z.infer<typeof errorTypeResponseSchema>;

// ---------------------------------------------------------------- 別名

export const createTagAliasSchema = z
  .object({
    tagKind: tagKindSchema,
    alias: tagNameSchema,
    canonicalTagId: uuidSchema,
  })
  .strict();
export type CreateTagAliasRequest = z.infer<typeof createTagAliasSchema>;

export const tagAliasResponseSchema = z.object({
  id: z.string().uuid(),
  tagKind: tagKindSchema,
  alias: z.string(),
  normalizedAlias: z.string(),
  canonicalTagId: z.string().uuid(),
  canonicalTagName: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type TagAliasResponse = z.infer<typeof tagAliasResponseSchema>;

export const listTagAliasesQuerySchema = z.object({
  tagKind: tagKindSchema.optional(),
  canonicalTagId: uuidSchema.optional(),
});
export type ListTagAliasesQuery = z.infer<typeof listTagAliasesQuerySchema>;

/** 名稱解析結果，供前端與 Phase 4 的 AI 輸出對照使用。 */
export const resolveTagNameQuerySchema = z.object({
  tagKind: tagKindSchema,
  name: tagNameSchema,
});
export type ResolveTagNameQuery = z.infer<typeof resolveTagNameQuerySchema>;

export const resolveTagNameResponseSchema = z.object({
  input: z.string(),
  normalized: z.string(),
  /** 對應到的既有標籤；對不上就是 null，代表只能走建議流程。 */
  matchedTagId: z.string().uuid().nullable(),
  matchedTagName: z.string().nullable(),
  matchedVia: z.enum(['name', 'alias']).nullable(),
});
export type ResolveTagNameResponse = z.infer<typeof resolveTagNameResponseSchema>;

// ---------------------------------------------------------------- 標籤建議

export const createTagSuggestionSchema = z
  .object({
    tagKind: tagKindSchema,
    suggestedName: tagNameSchema,
    contextQuestionId: uuidSchema.nullish(),
    rationale: z.string().trim().max(2000).nullish(),
  })
  .strict();
export type CreateTagSuggestionRequest = z.infer<typeof createTagSuggestionSchema>;

export const tagSuggestionStatusSchema = z.enum(['pending', 'approved', 'merged', 'rejected']);
export type TagSuggestionStatus = z.infer<typeof tagSuggestionStatusSchema>;

export const tagSuggestionResponseSchema = z.object({
  id: z.string().uuid(),
  tagKind: tagKindSchema,
  suggestedName: z.string(),
  normalizedName: z.string(),
  contextQuestionId: z.string().uuid().nullable(),
  contextQuestionStem: z.string().nullable(),
  source: z.enum(['ai', 'user']),
  rationale: z.string().nullable(),
  /** 同一個名稱重複被建議的次數，讓真正需要的標籤自然浮上來。 */
  occurrenceCount: z.number().int(),
  status: tagSuggestionStatusSchema,
  resolvedTagId: z.string().uuid().nullable(),
  resolvedTagName: z.string().nullable(),
  reviewedAt: z.string().datetime().nullable(),
  reviewNote: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type TagSuggestionResponse = z.infer<typeof tagSuggestionResponseSchema>;

export const listTagSuggestionsQuerySchema = paginationQuerySchema.extend({
  status: tagSuggestionStatusSchema.optional(),
  tagKind: tagKindSchema.optional(),
});
export type ListTagSuggestionsQuery = z.infer<typeof listTagSuggestionsQuerySchema>;

/** 核准建議 → 建立正式標籤。允許審核時順手改名，因為 AI 給的名稱未必符合命名習慣。 */
export const approveTagSuggestionSchema = z
  .object({
    name: tagNameSchema.optional(),
    subjectId: uuidSchema.nullish(),
    description: z.string().trim().max(1000).nullish(),
    reviewNote: z.string().trim().max(1000).nullish(),
  })
  .strict();
export type ApproveTagSuggestionRequest = z.infer<typeof approveTagSuggestionSchema>;

/** 併入既有標籤 → 同時自動建立別名，下次同樣名稱就不會再變成建議。 */
export const mergeTagSuggestionSchema = z
  .object({
    targetTagId: uuidSchema,
    reviewNote: z.string().trim().max(1000).nullish(),
  })
  .strict();
export type MergeTagSuggestionRequest = z.infer<typeof mergeTagSuggestionSchema>;

export const rejectTagSuggestionSchema = z
  .object({
    reviewNote: z.string().trim().max(1000).nullish(),
  })
  .strict();
export type RejectTagSuggestionRequest = z.infer<typeof rejectTagSuggestionSchema>;

// ---------------------------------------------------------------- 題目標籤關聯

export const questionTagResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  role: tagRoleSchema,
  source: tagSourceSchema,
  confidence: z.number().nullable(),
});
export type QuestionTagResponse = z.infer<typeof questionTagResponseSchema>;

/**
 * 設定題目的標籤。
 *
 * 刻意獨立於 `PATCH /questions/:id`：標籤不是題目內容，
 * 若走題目更新端點會連帶遞增 `currentVersion` 並改寫版本快照，
 * 讓「這題被改過幾次」失去意義。標籤變更也不影響 `content_hash`，
 * 因此不會使 Phase 4 的 AI 分析快取失效。
 */
export const setQuestionTagsSchema = z
  .object({
    primaryKnowledgeTagId: uuidSchema.nullish(),
    secondaryKnowledgeTagIds: z.array(uuidSchema).max(SECONDARY_KNOWLEDGE_TAG_MAX).default([]),
    primarySkillTagId: uuidSchema.nullish(),
    secondarySkillTagIds: z.array(uuidSchema).max(SECONDARY_SKILL_TAG_MAX).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const knowledge = value.secondaryKnowledgeTagIds;
    if (new Set(knowledge).size !== knowledge.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['secondaryKnowledgeTagIds'],
        message: '次要知識點不可重複',
      });
    }
    if (value.primaryKnowledgeTagId && knowledge.includes(value.primaryKnowledgeTagId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['secondaryKnowledgeTagIds'],
        message: '次要知識點不可與主要知識點相同',
      });
    }

    const skills = value.secondarySkillTagIds;
    if (new Set(skills).size !== skills.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['secondarySkillTagIds'],
        message: '次要能力類型不可重複',
      });
    }
    if (value.primarySkillTagId && skills.includes(value.primarySkillTagId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['secondarySkillTagIds'],
        message: '次要能力類型不可與主要能力類型相同',
      });
    }
  });
export type SetQuestionTagsRequest = z.infer<typeof setQuestionTagsSchema>;

/** 手動標記錯題的錯誤類型。Phase 4 的 AI 分析會寫入同一張表（source = 'ai'）。 */
export const setMistakeErrorTypesSchema = z
  .object({
    errorTypeIds: z.array(uuidSchema).max(5),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.errorTypeIds).size !== value.errorTypeIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['errorTypeIds'],
        message: '錯誤類型不可重複',
      });
    }
  });
export type SetMistakeErrorTypesRequest = z.infer<typeof setMistakeErrorTypesSchema>;
