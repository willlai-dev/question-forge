#!/usr/bin/env node
/**
 * 環境變數啟動器（bootstrap-env）
 *
 * 設計原則（對應 prompt.md「環境變數與密鑰管理」章節）：
 *   1. 使用者只需手動提供 3 個變數：NVIDIA_API_KEY / TAVILY_API_KEY / DATABASE_URL。
 *   2. 其餘密鑰由本腳本以 crypto.randomBytes 自動產生。
 *   3. 本腳本「只新增、不覆寫」：任何已存在的鍵一律原封不動，因此可安全重複執行（idempotent）。
 *   4. 全程不印出任何變數「內容」，只印鍵名與狀態。
 *   5. 另外產生 apps/web/.env.local，且其中「只含 NEXT_PUBLIC_* 」，
 *      以結構性方式保證後端機密不可能外流到前端 bundle。
 *
 * 用法：
 *   node scripts/bootstrap-env.mjs           # 一般執行（有完整輸出）
 *   node scripts/bootstrap-env.mjs --quiet   # 安靜模式（postinstall 用，缺變數不中斷安裝）
 *   node scripts/bootstrap-env.mjs --check   # 只檢查不寫入，缺必要變數時以非 0 結束
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ENV_PATH = join(ROOT, '.env');
const WEB_ENV_PATH = join(ROOT, 'apps', 'web', '.env.local');

const argv = new Set(process.argv.slice(2));
const QUIET = argv.has('--quiet');
const CHECK_ONLY = argv.has('--check');

/** 使用者必須自行提供、系統絕不自動產生的變數 */
const REQUIRED_FROM_USER = ['NVIDIA_API_KEY', 'TAVILY_API_KEY', 'DATABASE_URL'];

/** 需自動產生的密鑰：key -> 位元組長度 */
const GENERATED_SECRETS = {
  JWT_ACCESS_SECRET: 48,
  JWT_REFRESH_SECRET: 48,
  COOKIE_SECRET: 48,
  CSRF_SECRET: 32,
  REDIS_PASSWORD: 24,
};

/**
 * 非機密的開發預設值。
 * 分區塊是為了讓產生出來的 .env 仍然可讀。
 */
const DEFAULT_SECTIONS = [
  {
    title: '執行環境',
    vars: {
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      PORT: '4000',
      API_GLOBAL_PREFIX: 'api/v1',
      BACKEND_URL: 'http://localhost:4000',
      FRONTEND_URL: 'http://localhost:3000',
      CORS_ORIGIN: 'http://localhost:3000',
    },
  },
  {
    title: '前端公開變數（唯一會被寫入 apps/web/.env.local 的前綴）',
    vars: {
      NEXT_PUBLIC_API_URL: 'http://localhost:4000/api/v1',
      NEXT_PUBLIC_APP_NAME: '題庫分析系統',
    },
  },
  {
    title: 'Redis（由 docker-compose 啟動，密碼為自動產生）',
    vars: {
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: '6379',
      REDIS_DB: '0',
      REDIS_TEST_DB: '1',
    },
  },
  {
    title: '認證',
    vars: {
      JWT_ACCESS_TTL: '15m',
      JWT_REFRESH_TTL: '30d',
      AUTH_COOKIE_SECURE: 'false',
      AUTH_COOKIE_SAMESITE: 'lax',
      AUTH_COOKIE_DOMAIN: 'localhost',
    },
  },
  {
    title: 'NVIDIA AI（模型名稱已於規劃階段實測存在）',
    vars: {
      AI_PROVIDER: 'nvidia',
      NVIDIA_API_BASE_URL: 'https://integrate.api.nvidia.com/v1',
      NVIDIA_MODEL: 'nvidia/nemotron-3-ultra-550b-a55b',
      NVIDIA_MAX_RPM: '30',
      NVIDIA_RETRY_RESERVE_RPM: '8',
      NVIDIA_MAX_CONCURRENT: '2',
      NVIDIA_REQUEST_TIMEOUT_MS: '180000',
      NVIDIA_MAX_RETRIES_429: '5',
      NVIDIA_MAX_RETRIES_5XX: '3',
      NVIDIA_MAX_SCHEMA_REGENERATIONS: '2',
    },
  },
  {
    title: 'AI 三階段參數（reasoning_effort 為 NVIDIA 實際支援的參數）',
    vars: {
      AI_REASONING_EFFORT_PLAN: 'low',
      AI_REASONING_EFFORT_EVIDENCE: 'medium',
      AI_REASONING_EFFORT_FINAL: 'high',
      AI_REASONING_EFFORT_AGGREGATE: 'high',
      AI_MAX_TOKENS_PLAN: '1500',
      AI_MAX_TOKENS_EVIDENCE: '3000',
      AI_MAX_TOKENS_FINAL: '4500',
      AI_MAX_TOKENS_AGGREGATE: '4500',
      AI_TEMPERATURE: '0.2',
    },
  },
  {
    title: '搜尋（Tavily）',
    vars: {
      SEARCH_PROVIDER: 'tavily',
      TAVILY_API_BASE_URL: 'https://api.tavily.com',
      TAVILY_SEARCH_DEPTH: 'basic',
      TAVILY_MAX_QUERIES_PER_QUESTION: '3',
      TAVILY_MAX_RESULTS_PER_QUERY: '5',
      SEARCH_CACHE_TTL_SECONDS: '604800',
      EXTRACT_CACHE_TTL_SECONDS: '2592000',
      EVIDENCE_SOURCE_MAX_CHARS: '4000',
      EVIDENCE_TOTAL_MAX_CHARS: '24000',
      EVIDENCE_STALE_AFTER_DAYS: '90',
    },
  },
  {
    title: 'BullMQ 背景工作',
    vars: {
      WORKER_INLINE: 'true',
      QUEUE_PREFIX: 'qba',
      BULLMQ_CONCURRENCY: '2',
      BULLMQ_MAX_ATTEMPTS: '3',
      BULLMQ_BACKOFF_MS: '5000',
      BULLMQ_JOB_TIMEOUT_MS: '600000',
      BULLMQ_REMOVE_ON_COMPLETE: '200',
      BULLMQ_REMOVE_ON_FAIL: '500',
    },
  },
  {
    title: '上傳與 API 限制',
    vars: {
      IMPORT_MAX_FILE_SIZE_BYTES: '10485760',
      IMPORT_MAX_QUESTIONS: '2000',
      API_RATE_LIMIT_WINDOW_MS: '60000',
      API_RATE_LIMIT_MAX: '300',
    },
  },
  {
    title: '外部網頁擷取（SSRF 防護上限）',
    vars: {
      WEB_FETCH_TIMEOUT_MS: '8000',
      WEB_FETCH_MAX_BYTES: '2097152',
      WEB_FETCH_MAX_REDIRECTS: '3',
    },
  },
];

// ---------------------------------------------------------------- helpers

const log = (...args) => {
  if (!QUIET) console.log(...args);
};

/** 產生 URL 安全的隨機密鑰 */
const generateSecret = (bytes) => randomBytes(bytes).toString('base64url');

/**
 * 極簡 .env 解析：只取「鍵是否存在且有值」，不做跳脫處理。
 * 刻意不回傳值給呼叫端印出，避免任何洩漏路徑。
 */
function parseEnv(text) {
  const map = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) map.set(key, value);
  }
  return map;
}

const escapeValue = (value) => (/[\s#"']/.test(value) ? JSON.stringify(value) : value);

// ---------------------------------------------------------------- main

function main() {
  const envExists = existsSync(ENV_PATH);
  const originalText = envExists ? readFileSync(ENV_PATH, 'utf8') : '';
  const existing = parseEnv(originalText);

  // --- 1. 檢查使用者必須提供的三個變數 -------------------------------
  const missingRequired = REQUIRED_FROM_USER.filter((k) => !existing.get(k));

  if (!envExists) {
    if (CHECK_ONLY) {
      console.error('[env] 找不到 .env，請先依 .env.example 建立並填入三個必要變數。');
      process.exit(1);
    }
    log('[env] 找不到 .env，將建立含必要變數佔位的新檔。');
  }

  if (missingRequired.length > 0) {
    const msg =
      `[env] 缺少必要變數（需由你手動填入）：${missingRequired.join(', ')}\n` +
      `      請編輯 ${ENV_PATH} 後重新執行。`;
    if (CHECK_ONLY) {
      console.error(msg);
      process.exit(1);
    }
    // postinstall 情境不中斷安裝，只提醒。
    console.warn(msg);
  }

  if (CHECK_ONLY) {
    log('[env] 檢查通過：三個必要變數皆已提供。');
    return;
  }

  // --- 2. 組出需要補上的內容（只補缺的，絕不覆寫已有值） ----------------
  const appended = [];
  const addedKeys = [];
  /** 鍵已存在但值是空的 → 就地補值（見下方 isBlank 的說明）。 */
  const filledInPlace = new Map();

  // 「沒有這個鍵」與「有這個鍵但值是空字串」都算缺。
  // 照 README 執行 `cp .env.example .env` 之後，每個自動產生的鍵都已經存在但為空；
  // 若只用 has() 判斷，這裡會誤判為「已完整」而一個密鑰都不產生，
  // 導致 redis:up 與 API 啟動全部失敗，且再跑一次本腳本也修不好。
  const isBlank = (key) => !existing.get(key);

  const addSection = (title, entries) => {
    const pending = entries.filter(([key]) => isBlank(key));
    if (pending.length === 0) return;
    const toAppend = [];
    for (const [key, value] of pending) {
      if (existing.has(key)) filledInPlace.set(key, value);
      else toAppend.push(`${key}=${escapeValue(value)}`);
      existing.set(key, value);
      addedKeys.push(key);
    }
    if (toAppend.length > 0) appended.push('', `# --- ${title} ---`, ...toAppend);
  };

  // 2a. 新檔時先放必要變數的空佔位
  if (!envExists) {
    appended.push('# 由你手動填入的三個變數（其餘皆為系統自動產生）');
    for (const key of REQUIRED_FROM_USER) {
      appended.push(`${key}=`);
    }
  }

  // 2b. 自動產生的密鑰
  addSection(
    '自動產生的密鑰（請勿外流，勿手動更動）',
    Object.entries(GENERATED_SECRETS).map(([key, bytes]) => [key, generateSecret(bytes)]),
  );

  // 2c. 非機密預設值
  for (const section of DEFAULT_SECTIONS) {
    addSection(section.title, Object.entries(section.vars));
  }

  // 2d. REDIS_URL 由密碼與主機推導（若使用者已自訂則保留）
  if (isBlank('REDIS_URL')) {
    const password = existing.get('REDIS_PASSWORD') ?? '';
    const host = existing.get('REDIS_HOST') ?? '127.0.0.1';
    const port = existing.get('REDIS_PORT') ?? '6379';
    const db = existing.get('REDIS_DB') ?? '0';
    addSection('Redis 連線字串（由上方密碼推導）', [
      ['REDIS_URL', `redis://:${password}@${host}:${port}/${db}`],
    ]);
  }

  // --- 3. 寫回 .env ---------------------------------------------------
  // 空值的鍵就地補上（不改動該行以外的任何內容，也不重複附加同名鍵，
  // 免得同一個變數在檔案裡出現兩次、靠解析器的先後順序決定勝負）；
  // 完全不存在的鍵才附加到檔尾。有值的鍵一律原封不動。
  if (appended.length > 0 || filledInPlace.size > 0) {
    let text = originalText;
    for (const [key, value] of filledInPlace) {
      const pattern = new RegExp(`^([ \\t]*${key}[ \\t]*=)[ \\t]*$`, 'm');
      text = text.replace(pattern, `$1${escapeValue(value)}`);
    }
    if (appended.length > 0) {
      const needsNewline = text.length > 0 && !text.endsWith('\n');
      text += (needsNewline ? '\n' : '') + appended.join('\n') + '\n';
    }
    writeFileSync(ENV_PATH, text, 'utf8');
    log(`[env] 已補上 ${addedKeys.length} 個變數：${addedKeys.join(', ')}`);
  } else {
    log('[env] .env 已完整，無需變更。');
  }

  // --- 4. 產生前端 .env.local：只含 NEXT_PUBLIC_* --------------------
  const publicEntries = [...existing.entries()].filter(([key]) => key.startsWith('NEXT_PUBLIC_'));
  const webDir = dirname(WEB_ENV_PATH);
  if (existsSync(webDir)) {
    const header = [
      '# 本檔由 scripts/bootstrap-env.mjs 自動產生，請勿手動編輯。',
      '# 僅包含 NEXT_PUBLIC_* 變數；任何後端機密都不會出現在此。',
      '',
    ];
    const body = publicEntries.map(([key, value]) => `${key}=${value}`);
    writeFileSync(WEB_ENV_PATH, header.concat(body).join('\n') + '\n', 'utf8');
    log(`[env] 已寫入 apps/web/.env.local（${publicEntries.length} 個公開變數）`);
  } else {
    log('[env] 尚未建立 apps/web，略過前端環境檔。');
  }

  // --- 5. 摘要（只印鍵名，絕不印值） ---------------------------------
  if (!QUIET) {
    const secretKeys = new Set([...REQUIRED_FROM_USER, ...Object.keys(GENERATED_SECRETS), 'REDIS_URL']);
    log('\n[env] 機密變數狀態（僅顯示是否已設定）：');
    for (const key of secretKeys) {
      const ok = Boolean(existing.get(key));
      log(`      ${ok ? '✔' : '✘'} ${key}${ok ? '' : '  <- 尚未設定'}`);
    }
    log('');
  }
}

main();
