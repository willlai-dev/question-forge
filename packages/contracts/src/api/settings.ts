import { z } from 'zod';

import { quizModeSchema, orderStrategySchema, revealModeSchema, QUIZ_QUESTION_LIMIT_MAX } from './quiz';

/**
 * 系統設定（規格 §16 的「系統設定頁」）。
 *
 * 規格只寫了一行「系統設定頁」，沒有定義內容。這裡刻意收斂成**改動不會破壞既有資料**
 * 的項目：作答預設值，加上唯讀的系統資訊。
 *
 * 明確不放進來的：
 *   - 任何機密（金鑰、連線字串、密鑰）—— 只顯示「已設定／未設定」，永遠不回傳內容。
 *   - 限流與重試參數 —— 調錯會直接讓 AI 分析失敗或超額，且有跨欄位限制。
 *   - Prompt 版本切換 —— 版本是快取鍵的一部分，切換等於讓既有解析全部失效。
 */

/** 作答預設值。存在 app_settings 的 `quiz.defaults`。 */
export const quizDefaultsSchema = z
  .object({
    mode: quizModeSchema.default('practice'),
    orderStrategy: orderStrategySchema.default('sequential'),
    shuffleOptions: z.boolean().default(false),
    /** null 代表不限題數。 */
    questionLimit: z.number().int().positive().max(QUIZ_QUESTION_LIMIT_MAX).nullable().default(20),
    revealMode: revealModeSchema.default('immediate'),
    allowAnswerChange: z.boolean().default(true),
  })
  .strict();
export type QuizDefaults = z.infer<typeof quizDefaultsSchema>;

export const QUIZ_DEFAULTS_KEY = 'quiz.defaults';

/** 唯讀的系統資訊。機密一律只給布林值。 */
export const systemInfoSchema = z.object({
  aiProvider: z.string(),
  searchProvider: z.string(),
  model: z.string(),
  reasoningEffort: z.object({
    plan: z.string(),
    evidence: z.string(),
    final: z.string(),
    aggregate: z.string(),
  }),
  evidenceStaleAfterDays: z.number().int(),
  /** 只表示「有沒有設定」，永遠不含內容。 */
  secretsConfigured: z.record(z.string(), z.boolean()),
});
export type SystemInfo = z.infer<typeof systemInfoSchema>;

export const settingsResponseSchema = z.object({
  quizDefaults: quizDefaultsSchema,
  system: systemInfoSchema,
});
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

export const updateSettingsSchema = z
  .object({
    quizDefaults: quizDefaultsSchema.partial().optional(),
  })
  .strict();
export type UpdateSettingsRequest = z.infer<typeof updateSettingsSchema>;

// ---------------------------------------------------------------- 維護作業

/**
 * 維護作業（規格 §19 Phase 5 的「維護佇列」）。
 *
 * 刻意做成**手動觸發**而非自動排程：這是單機自用的工具，關機時排程不會執行，
 * 而「會自己刪資料的背景程序」風險高於效益。先預覽再執行，刪掉幾筆一律回報。
 */
export const maintenancePreviewSchema = z.object({
  expiredWebDocuments: z.number().int(),
  expiredEvidenceSets: z.number().int(),
  orphanWebDocuments: z.number().int(),
});
export type MaintenancePreview = z.infer<typeof maintenancePreviewSchema>;

export const maintenanceCleanupResultSchema = z.object({
  deletedWebDocuments: z.number().int(),
  deletedEvidenceSets: z.number().int(),
  recomputedMistakeRecords: z.number().int(),
});
export type MaintenanceCleanupResult = z.infer<typeof maintenanceCleanupResultSchema>;

export const maintenanceCleanupSchema = z
  .object({
    /** 預設只清過期資料；要一併重算錯題統計才明確帶上。 */
    recomputeMistakes: z.boolean().default(false),
  })
  .strict();
export type MaintenanceCleanupRequest = z.infer<typeof maintenanceCleanupSchema>;
