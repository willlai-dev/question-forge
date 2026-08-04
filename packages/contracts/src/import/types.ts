import { z } from 'zod';

/**
 * 題庫匯入格式與驗證問題定義。
 *
 * 對應 docs/QUESTION_IMPORT_SCHEMA.json 與 docs/API_CONTRACT.md §5。
 *
 * 設計重點：檔案「不」以單一 Zod schema 一次驗證通過或失敗。
 * 使用者需要的是「哪一題有什麼問題」，而不是整份被拒絕，
 * 因此結構解析與逐題規則檢查是分開的兩層。
 */

/**
 * 支援的匯入格式版本。
 *
 * 1.1.0 新增 `notes`（章節筆記）與題目的 `relatedNoteIds`。
 * 1.0.0 continues to be accepted —— 舊檔案不該因為格式演進就匯不進來，
 * 而且 1.1.0 的新欄位全部選填，兩者在同一支驗證器裡差異極小。
 */
export const SUPPORTED_SCHEMA_VERSIONS = ['1.0.0', '1.1.0'] as const;

/** 單筆筆記的長度上限。超過通常代表整章被塞成一段，檢索會失去意義。 */
export const NOTE_CONTENT_MAX_CHARS = 20_000;

/** 單次匯入的筆記數量上限。 */
export const MAX_NOTES_PER_IMPORT = 200;

export const IMPORT_ISSUE_CODES = {
  // --- 阻斷性錯誤 ---
  UNSUPPORTED_SCHEMA_VERSION: 'UNSUPPORTED_SCHEMA_VERSION',
  INVALID_FILE_STRUCTURE: 'INVALID_FILE_STRUCTURE',
  INVALID_ROW_SHAPE: 'INVALID_ROW_SHAPE',
  INVALID_QUESTION_TYPE: 'INVALID_QUESTION_TYPE',
  EMPTY_STEM: 'EMPTY_STEM',
  TOO_FEW_OPTIONS: 'TOO_FEW_OPTIONS',
  DUPLICATE_OPTION_KEY: 'DUPLICATE_OPTION_KEY',
  EMPTY_OPTION_TEXT: 'EMPTY_OPTION_TEXT',
  CORRECT_ANSWER_NOT_IN_OPTIONS: 'CORRECT_ANSWER_NOT_IN_OPTIONS',
  NO_CORRECT_ANSWER: 'NO_CORRECT_ANSWER',
  SINGLE_CHOICE_MULTIPLE_ANSWERS: 'SINGLE_CHOICE_MULTIPLE_ANSWERS',
  MULTIPLE_CHOICE_TOO_FEW_ANSWERS: 'MULTIPLE_CHOICE_TOO_FEW_ANSWERS',
  DUPLICATE_EXTERNAL_ID_IN_BATCH: 'DUPLICATE_EXTERNAL_ID_IN_BATCH',
  DUPLICATE_EXTERNAL_ID_IN_DB: 'DUPLICATE_EXTERNAL_ID_IN_DB',
  DUPLICATE_QUESTION_NUMBER_IN_BATCH: 'DUPLICATE_QUESTION_NUMBER_IN_BATCH',
  DUPLICATE_QUESTION_NUMBER_IN_DB: 'DUPLICATE_QUESTION_NUMBER_IN_DB',
  INVALID_QUESTION_NUMBER: 'INVALID_QUESTION_NUMBER',
  INVALID_SOURCE_PAGE: 'INVALID_SOURCE_PAGE',
  TOO_MANY_QUESTIONS: 'TOO_MANY_QUESTIONS',
  // --- 筆記（schemaVersion 1.1.0）---
  INVALID_NOTE_SHAPE: 'INVALID_NOTE_SHAPE',
  DUPLICATE_NOTE_ID: 'DUPLICATE_NOTE_ID',
  EMPTY_NOTE_CONTENT: 'EMPTY_NOTE_CONTENT',
  NOTE_CONTENT_TOO_LONG: 'NOTE_CONTENT_TOO_LONG',
  TOO_MANY_NOTES: 'TOO_MANY_NOTES',
  /**
   * 題目引用了不存在的 noteId。
   *
   * 這是 error 而不是 warning：靜靜忽略一個對不上的引用，
   * 等於讓使用者以為某題掛了筆記，實際上分析時根本沒帶進去。
   */
  UNKNOWN_NOTE_REFERENCE: 'UNKNOWN_NOTE_REFERENCE',

  // --- 警告（不阻擋 commit）---
  MISSING_EXPLANATION: 'MISSING_EXPLANATION',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  MISSING_REVIEW_REASON: 'MISSING_REVIEW_REASON',
  OPTION_KEY_NOT_UPPERCASE: 'OPTION_KEY_NOT_UPPERCASE',
  STEM_TOO_LONG: 'STEM_TOO_LONG',
  MISSING_EXTERNAL_ID: 'MISSING_EXTERNAL_ID',
} as const;

export type ImportIssueCode = (typeof IMPORT_ISSUE_CODES)[keyof typeof IMPORT_ISSUE_CODES];

export type ImportIssueLevel = 'error' | 'warning';

export interface ImportIssue {
  level: ImportIssueLevel;
  code: ImportIssueCode;
  message: string;
  fieldPath?: string;
  /** 對應 questions 陣列的索引；檔案層級問題為 null。 */
  rowIndex: number | null;
}

/** 匯入格式中「一筆題目」的寬鬆形狀：欄位可能缺漏或型別錯誤，由規則層逐條檢查。 */
export const rawImportQuestionSchema = z.object({}).passthrough();

/**
 * 檔案層級的最小結構要求。
 * 只檢查「能不能逐題處理」，其餘一律交給規則層，以便產出逐題的問題清單。
 */
export const rawImportFileSchema = z
  .object({
    schemaVersion: z.unknown(),
    subject: z.unknown(),
    chapter: z.unknown().optional(),
    questionGroup: z.unknown(),
    sourceDocument: z.unknown().optional(),
    /** schemaVersion 1.1.0 起的章節筆記。 */
    notes: z.unknown().optional(),
    questions: z.array(rawImportQuestionSchema),
  })
  .passthrough();

export type RawImportFile = z.infer<typeof rawImportFileSchema>;

// ---------------------------------------------------------------- 匯入 API 回應

export const importBatchStatusSchema = z.enum([
  'uploaded',
  'validating',
  'validated',
  'partially_valid',
  'failed',
  'committing',
  'committed',
  'discarded',
]);
export type ImportBatchStatus = z.infer<typeof importBatchStatusSchema>;

export const importQuestionStatusSchema = z.enum([
  'pending',
  'valid',
  'warning',
  'error',
  'excluded',
  'fixed',
  'committed',
]);
export type ImportQuestionStatus = z.infer<typeof importQuestionStatusSchema>;

export const importBatchResponseSchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  fileSize: z.number().int(),
  schemaVersion: z.string().nullable(),
  status: importBatchStatusSchema,
  targetSubjectId: z.string().uuid().nullable(),
  targetSubjectName: z.string().nullable(),
  targetChapterId: z.string().uuid().nullable(),
  targetChapterName: z.string().nullable(),
  targetGroupId: z.string().uuid().nullable(),
  targetGroupName: z.string().nullable(),
  totalCount: z.number().int(),
  validCount: z.number().int(),
  errorCount: z.number().int(),
  warningCount: z.number().int(),
  reviewRequiredCount: z.number().int(),
  committedCount: z.number().int(),
  /** 通過驗證的章節筆記數。1.0.0 的檔案永遠是 0。 */
  noteCount: z.number().int(),
  /** 檔案層級問題（例如 schemaVersion 不支援）。 */
  fileIssues: z.array(
    z.object({
      level: z.enum(['error', 'warning']),
      code: z.string(),
      message: z.string(),
    }),
  ),
  canCommit: z.boolean(),
  validatedAt: z.string().datetime().nullable(),
  committedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ImportBatchResponse = z.infer<typeof importBatchResponseSchema>;

export const importQuestionResponseSchema = z.object({
  id: z.string().uuid(),
  rowIndex: z.number().int(),
  externalId: z.string().nullable(),
  questionNumber: z.number().int().nullable(),
  type: z.string().nullable(),
  stem: z.string().nullable(),
  options: z
    .array(z.object({ key: z.string(), text: z.string(), isCorrect: z.boolean() }))
    .nullable(),
  explanation: z.string().nullable(),
  sourcePage: z.number().int().nullable(),
  sourceReference: z.string().nullable(),
  reviewRequired: z.boolean(),
  reviewReason: z.string().nullable(),
  status: importQuestionStatusSchema,
  issues: z.array(
    z.object({
      level: z.enum(['error', 'warning']),
      code: z.string(),
      message: z.string(),
      fieldPath: z.string().nullable(),
    }),
  ),
  resultingQuestionId: z.string().uuid().nullable(),
});
export type ImportQuestionResponse = z.infer<typeof importQuestionResponseSchema>;

/** 在預覽頁修正單題。欄位全為選填，只更新有帶的部分。 */
export const fixImportQuestionSchema = z
  .object({
    questionNumber: z.number().int().positive().nullish(),
    type: z.enum(['single_choice', 'multiple_choice']).nullish(),
    stem: z.string().trim().max(8000).nullish(),
    options: z
      .array(
        z.object({
          key: z.string().trim().max(4),
          text: z.string().trim().max(2000),
          isCorrect: z.boolean(),
        }),
      )
      .nullish(),
    explanation: z.string().trim().max(8000).nullish(),
    sourcePage: z.number().int().positive().nullish(),
    sourceReference: z.string().trim().max(300).nullish(),
    reviewRequired: z.boolean().nullish(),
    reviewReason: z.string().trim().max(1000).nullish(),
  })
  .strict();
export type FixImportQuestionRequest = z.infer<typeof fixImportQuestionSchema>;

/** commit 時指定匯入目標。未指定則沿用檔案內容建立。 */
export const commitImportSchema = z
  .object({
    targetSubjectId: z.string().uuid().nullish(),
    targetChapterId: z.string().uuid().nullish(),
    targetGroupId: z.string().uuid().nullish(),
  })
  .strict();
export type CommitImportRequest = z.infer<typeof commitImportSchema>;

export const commitImportResultSchema = z.object({
  batchId: z.string().uuid(),
  committedCount: z.number().int(),
  skippedCount: z.number().int(),
  subjectId: z.string().uuid(),
  chapterId: z.string().uuid().nullable(),
  questionGroupId: z.string().uuid(),
});
export type CommitImportResult = z.infer<typeof commitImportResultSchema>;
