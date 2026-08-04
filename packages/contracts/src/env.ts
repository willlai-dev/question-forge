import { z } from 'zod';

/**
 * 環境變數 Schema —— 對應 prompt.md「環境變數與密鑰管理」第 13 點：
 * 所有環境變數必須經過啟動時 Schema validation。
 *
 * 安全要求：驗證失敗時只能回報「鍵名」，絕不可把值放進錯誤訊息或 log。
 * 因此本檔一律使用自訂錯誤訊息，不使用 Zod 預設的 received value 輸出。
 */

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} 不可為空`);

const boolFromString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();

/** NVIDIA 實際支援的 reasoning_effort 值（已於規劃階段向 API 實測確認） */
export const reasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const envSchema = z.object({
  // --- 由使用者提供的三個必要變數 ---
  NVIDIA_API_KEY: nonEmpty('NVIDIA_API_KEY'),
  TAVILY_API_KEY: nonEmpty('TAVILY_API_KEY'),
  DATABASE_URL: nonEmpty('DATABASE_URL').refine(
    (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'),
    'DATABASE_URL 必須是 postgres:// 或 postgresql:// 開頭的連線字串',
  ),

  // --- 自動產生的密鑰 ---
  JWT_ACCESS_SECRET: nonEmpty('JWT_ACCESS_SECRET').min(32, 'JWT_ACCESS_SECRET 長度不足 32'),
  JWT_REFRESH_SECRET: nonEmpty('JWT_REFRESH_SECRET').min(32, 'JWT_REFRESH_SECRET 長度不足 32'),
  COOKIE_SECRET: nonEmpty('COOKIE_SECRET').min(32, 'COOKIE_SECRET 長度不足 32'),
  CSRF_SECRET: nonEmpty('CSRF_SECRET').min(16, 'CSRF_SECRET 長度不足 16'),
  REDIS_PASSWORD: nonEmpty('REDIS_PASSWORD'),
  REDIS_URL: nonEmpty('REDIS_URL'),

  // --- 執行環境 ---
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: port.default(4000),
  API_GLOBAL_PREFIX: z.string().default('api/v1'),
  BACKEND_URL: z.string().url().default('http://localhost:4000'),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  // --- Redis ---
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: port.default(6379),
  REDIS_DB: nonNegativeInt.default(0),
  REDIS_TEST_DB: nonNegativeInt.default(1),

  // --- 認證 ---
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  AUTH_COOKIE_SECURE: boolFromString.default('false'),
  AUTH_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  AUTH_COOKIE_DOMAIN: z.string().default('localhost'),

  // --- AI provider ---
  AI_PROVIDER: z.enum(['nvidia', 'mock']).default('nvidia'),
  NVIDIA_API_BASE_URL: z.string().url().default('https://integrate.api.nvidia.com/v1'),
  NVIDIA_MODEL: z.string().default('nvidia/nemotron-3-ultra-550b-a55b'),
  /** 免費額度 40 RPM；此值必須低於 40，並保留額度給重試（見 refine）。 */
  NVIDIA_MAX_RPM: positiveInt.default(30),
  NVIDIA_RETRY_RESERVE_RPM: nonNegativeInt.default(8),
  NVIDIA_MAX_CONCURRENT: positiveInt.default(2),
  NVIDIA_REQUEST_TIMEOUT_MS: positiveInt.default(180_000),
  NVIDIA_MAX_RETRIES_429: nonNegativeInt.default(5),
  NVIDIA_MAX_RETRIES_5XX: nonNegativeInt.default(3),
  NVIDIA_MAX_SCHEMA_REGENERATIONS: nonNegativeInt.default(2),

  // --- AI 三階段參數 ---
  AI_REASONING_EFFORT_PLAN: reasoningEffortSchema.default('low'),
  AI_REASONING_EFFORT_EVIDENCE: reasoningEffortSchema.default('medium'),
  AI_REASONING_EFFORT_FINAL: reasoningEffortSchema.default('high'),
  AI_MAX_TOKENS_PLAN: positiveInt.default(1500),
  AI_MAX_TOKENS_EVIDENCE: positiveInt.default(3000),
  AI_MAX_TOKENS_FINAL: positiveInt.default(4500),
  // 多題整合分析（Phase 5）：只呼叫一次模型，但要在大量統計數字中找出跨知識點的
  // 共同錯誤模式，屬於最需要推理的一步，因此與最終解析同級。
  AI_REASONING_EFFORT_AGGREGATE: reasoningEffortSchema.default('high'),
  AI_MAX_TOKENS_AGGREGATE: positiveInt.default(4500),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),

  // --- 搜尋 ---
  SEARCH_PROVIDER: z.enum(['tavily', 'mock']).default('tavily'),
  TAVILY_API_BASE_URL: z.string().url().default('https://api.tavily.com'),
  TAVILY_SEARCH_DEPTH: z.enum(['basic', 'advanced']).default('basic'),
  TAVILY_MAX_QUERIES_PER_QUESTION: positiveInt.max(3).default(3),
  TAVILY_MAX_RESULTS_PER_QUERY: positiveInt.max(20).default(5),
  SEARCH_CACHE_TTL_SECONDS: positiveInt.default(604_800),
  EXTRACT_CACHE_TTL_SECONDS: positiveInt.default(2_592_000),
  EVIDENCE_SOURCE_MAX_CHARS: positiveInt.default(4000),
  EVIDENCE_TOTAL_MAX_CHARS: positiveInt.default(24_000),
  EVIDENCE_STALE_AFTER_DAYS: positiveInt.default(90),
  /**
   * 章節筆記的字元預算，**與網頁來源分開計算**。
   *
   * 共用同一個池子的話，一段長筆記會把法條原文整個擠掉；
   * 反過來，幾則長網頁也會讓筆記完全進不來。兩邊各有額度才互不排擠。
   */
  NOTES_MAX_CHARS_PER_QUESTION: positiveInt.default(12_000),
  /** 單題最多帶入幾段筆記。超過通常代表關鍵字太泛，不如少而準。 */
  NOTES_MAX_PER_QUESTION: positiveInt.max(20).default(5),

  // --- BullMQ ---
  WORKER_INLINE: boolFromString.default('true'),
  QUEUE_PREFIX: z.string().default('qba'),
  BULLMQ_CONCURRENCY: positiveInt.default(2),
  BULLMQ_MAX_ATTEMPTS: positiveInt.default(3),
  BULLMQ_BACKOFF_MS: positiveInt.default(5000),
  BULLMQ_JOB_TIMEOUT_MS: positiveInt.default(600_000),
  BULLMQ_REMOVE_ON_COMPLETE: nonNegativeInt.default(200),
  BULLMQ_REMOVE_ON_FAIL: nonNegativeInt.default(500),

  // --- 上傳與 API 限制 ---
  IMPORT_MAX_FILE_SIZE_BYTES: positiveInt.default(10_485_760),
  IMPORT_MAX_QUESTIONS: positiveInt.default(2000),
  API_RATE_LIMIT_WINDOW_MS: positiveInt.default(60_000),
  API_RATE_LIMIT_MAX: positiveInt.default(300),

  // --- 外部網頁擷取 ---
  WEB_FETCH_TIMEOUT_MS: positiveInt.default(8000),
  WEB_FETCH_MAX_BYTES: positiveInt.default(2_097_152),
  WEB_FETCH_MAX_REDIRECTS: nonNegativeInt.default(3),
});

export type Env = z.infer<typeof envSchema>;

/** 這些鍵的值屬機密，任何情況下都不得寫入 log、錯誤訊息或 API 回應。 */
export const SECRET_ENV_KEYS = [
  'NVIDIA_API_KEY',
  'TAVILY_API_KEY',
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'COOKIE_SECRET',
  'CSRF_SECRET',
  'REDIS_PASSWORD',
  'REDIS_URL',
] as const satisfies readonly (keyof Env)[];

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`環境變數驗證失敗：\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * 驗證環境變數。
 *
 * 失敗時拋出的訊息「只包含鍵名與規則說明」，不包含任何變數值，
 * 對應 prompt.md 環境變數章第 8 點：缺失時提供明確錯誤訊息，但不得在 log 中印出其內容。
 */
export function validateEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (result.success) {
    const env = result.data;
    // 跨欄位規則：正常限制 + 重試保留額度不得超過免費額度 40 RPM。
    if (env.NVIDIA_MAX_RPM + env.NVIDIA_RETRY_RESERVE_RPM > 40) {
      throw new EnvValidationError([
        'NVIDIA_MAX_RPM 與 NVIDIA_RETRY_RESERVE_RPM 之和不得超過 40（免費額度上限）',
      ]);
    }
    return env;
  }

  const issues = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    return `${key}：${issue.message}`;
  });
  throw new EnvValidationError(issues);
}

/** 產生可安全寫入 log 的環境摘要（機密只顯示是否已設定）。 */
export function describeEnvForLog(env: Env): Record<string, string | number | boolean> {
  const secretKeys = new Set<string>(SECRET_ENV_KEYS);
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = secretKeys.has(key) ? '<已設定>' : (value as string | number | boolean);
  }
  return out;
}
