import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { validateEnv, type Env } from '@repo/contracts';
import { config as loadDotenv } from 'dotenv';

/** DI token：整個後端只有這裡能產生 Env，其他地方一律注入。 */
export const ENV = Symbol('ENV');

/**
 * 由目前檔案位置往上尋找 repo 根目錄。
 *
 * 用 marker 檔案判斷而非寫死相對層數，避免「從 src 執行」與「從 dist 執行」
 * 需要不同層數的問題。
 */
function findRepoRoot(startDir: string): string {
  let current = startDir;
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('找不到 repo 根目錄（缺少 pnpm-workspace.yaml）。');
}

let cached: Env | undefined;

/**
 * 載入並驗證環境變數。
 *
 * 對應 prompt.md 環境變數章第 8、13 點：
 *   - 啟動時檢查必要變數是否存在。
 *   - 缺失時提供明確錯誤訊息，但不得印出變數內容。
 * 驗證邏輯本身位於 @repo/contracts，前後端共用同一份規則。
 */
export function loadEnv(): Env {
  if (cached) return cached;

  const root = findRepoRoot(__dirname);
  // 環境變數統一放在 repo 根目錄，各 app 不各自維護一份。
  loadDotenv({ path: resolve(root, '.env') });

  cached = validateEnv(process.env);
  return cached;
}
