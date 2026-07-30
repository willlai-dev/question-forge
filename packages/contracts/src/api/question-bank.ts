import { z } from 'zod';

import { paginationQuerySchema, uuidSchema } from './common';

/**
 * 題庫階層契約：科目 → 章節 → 題組。
 *
 * 章節為選填：允許題組直接隸屬科目（FR-CAT-03）。
 * 「章節必屬同一科目」由資料庫複合外鍵保證（FR-CAT-05），
 * 但這裡仍會先做一次檢查以回傳友善錯誤，而非讓使用者看到資料庫錯誤。
 */

const nameSchema = z.string().trim().min(1, '名稱不可為空').max(200, '名稱最多 200 個字元');

// ---------------------------------------------------------------- 科目

export const createSubjectSchema = z
  .object({
    name: nameSchema.max(100, '科目名稱最多 100 個字元'),
    code: z.string().trim().max(50).nullish(),
    description: z.string().trim().max(1000).nullish(),
  })
  .strict();
export type CreateSubjectRequest = z.infer<typeof createSubjectSchema>;

export const updateSubjectSchema = createSubjectSchema.partial();
export type UpdateSubjectRequest = z.infer<typeof updateSubjectSchema>;

export const subjectResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  code: z.string().nullable(),
  description: z.string().nullable(),
  sortOrder: z.number().int(),
  chapterCount: z.number().int(),
  questionGroupCount: z.number().int(),
  questionCount: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SubjectResponse = z.infer<typeof subjectResponseSchema>;

// ---------------------------------------------------------------- 章節

export const createChapterSchema = z
  .object({
    subjectId: uuidSchema,
    name: nameSchema,
    description: z.string().trim().max(1000).nullish(),
  })
  .strict();
export type CreateChapterRequest = z.infer<typeof createChapterSchema>;

/** subjectId 不可變更：跨科目搬移章節會牽動底下所有題組與題目，屬另一個功能。 */
export const updateChapterSchema = createChapterSchema.omit({ subjectId: true }).partial();
export type UpdateChapterRequest = z.infer<typeof updateChapterSchema>;

export const chapterResponseSchema = z.object({
  id: z.string().uuid(),
  subjectId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  sortOrder: z.number().int(),
  questionGroupCount: z.number().int(),
  questionCount: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ChapterResponse = z.infer<typeof chapterResponseSchema>;

// ---------------------------------------------------------------- 題組

export const createQuestionGroupSchema = z
  .object({
    subjectId: uuidSchema,
    /** null 代表直接掛在科目下。 */
    chapterId: uuidSchema.nullish(),
    name: nameSchema,
    description: z.string().trim().max(2000).nullish(),
    source: z.string().trim().max(200).nullish(),
    year: z.number().int().min(1900).max(2200).nullish(),
    notes: z.string().trim().max(2000).nullish(),
  })
  .strict();
export type CreateQuestionGroupRequest = z.infer<typeof createQuestionGroupSchema>;

export const updateQuestionGroupSchema = createQuestionGroupSchema
  .omit({ subjectId: true })
  .partial();
export type UpdateQuestionGroupRequest = z.infer<typeof updateQuestionGroupSchema>;

export const questionGroupResponseSchema = z.object({
  id: z.string().uuid(),
  subjectId: z.string().uuid(),
  subjectName: z.string(),
  chapterId: z.string().uuid().nullable(),
  chapterName: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  source: z.string().nullable(),
  year: z.number().int().nullable(),
  notes: z.string().nullable(),
  sortOrder: z.number().int(),
  questionCount: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type QuestionGroupResponse = z.infer<typeof questionGroupResponseSchema>;

export const listQuestionGroupsQuerySchema = paginationQuerySchema.extend({
  subjectId: uuidSchema.optional(),
  /** 'none' 代表只找沒有章節的題組。 */
  chapterId: z.union([uuidSchema, z.literal('none')]).optional(),
  q: z.string().trim().max(200).optional(),
});
export type ListQuestionGroupsQuery = z.infer<typeof listQuestionGroupsQuerySchema>;
