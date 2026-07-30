#!/usr/bin/env node
/**
 * 建立整合測試專用的資料庫。
 *
 * 為什麼需要這支腳本：
 *   1. prompt.md 環境變數章第 7 點要求「PostgreSQL 不要在 Docker Compose 中重建」，
 *      所以測試資料庫必須建立在使用者既有的本機 PostgreSQL 上。
 *   2. 本機沒有安裝 psql CLI，因此改用 node-postgres 直接建立，不依賴外部指令。
 *   3. 測試資料庫名稱由 DATABASE_URL 推導（<db>_test），
 *      使用者因此不需要再多提供任何環境變數。
 *
 * 用法：
 *   node scripts/create-test-db.mjs          # 不存在才建立
 *   node scripts/create-test-db.mjs --drop   # 先刪除再重建（測試環境重置用）
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');
const DROP_FIRST = process.argv.includes('--drop');

function readDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (!existsSync(ENV_PATH)) {
    throw new Error('找不到 .env，且環境變數 DATABASE_URL 未設定。');
  }
  const match = readFileSync(ENV_PATH, 'utf8').match(/^DATABASE_URL=(.*)$/m);
  const value = match?.[1]?.trim();
  if (!value) throw new Error('DATABASE_URL 未設定。');
  return value;
}

async function main() {
  const url = new URL(readDatabaseUrl());
  const sourceDb = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!sourceDb) throw new Error('DATABASE_URL 未包含資料庫名稱。');

  const testDb = `${sourceDb}_test`;

  // 連到 maintenance 資料庫才能執行 CREATE DATABASE。
  const adminUrl = new URL(url.toString());
  adminUrl.pathname = '/postgres';

  const client = new pg.Client({ connectionString: adminUrl.toString() });
  await client.connect();

  try {
    if (DROP_FIRST) {
      // 先中斷既有連線，否則 DROP DATABASE 會失敗。
      await client.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [testDb],
      );
      await client.query(`DROP DATABASE IF EXISTS "${testDb}"`);
      console.log(`[db] 已刪除既有測試資料庫 ${testDb}`);
    }

    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [testDb]);

    if (rowCount && rowCount > 0) {
      console.log(`[db] 測試資料庫 ${testDb} 已存在，未做任何變更。`);
    } else {
      // 資料庫名稱來自我方推導而非使用者輸入，且以識別字引號包住。
      await client.query(`CREATE DATABASE "${testDb}"`);
      console.log(`[db] 已建立測試資料庫 ${testDb}`);
    }

    console.log('[db] 測試連線字串為主連線字串將資料庫名稱換成上述名稱（值不在此印出）。');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  // 只印訊息，避免把含密碼的連線字串寫進 log。
  console.error(`[db] 建立測試資料庫失敗：${error.message}`);
  process.exit(1);
});
