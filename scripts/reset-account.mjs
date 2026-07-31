#!/usr/bin/env node
/**
 * 重置帳號：刪除使用者並重新開放首次初始化頁面。
 *
 * 為什麼需要這支腳本：
 *   系統設計上「帳號建立後 /setup 永久停用」（FR-AUTH-02），
 *   這在正常使用時是正確的安全行為，但開發初期難免需要重來一次。
 *   把它寫成明確、需要 --yes 才會執行的腳本，比臨時下 SQL 安全且可稽核。
 *
 * 注意：使用者是題庫資料的擁有者，刪除會「連帶刪除」其科目、章節、題組、
 * 題目與匯入紀錄（資料庫層的 ON DELETE CASCADE）。執行前會先列出將被刪除的數量。
 *
 * 用法：
 *   node scripts/reset-account.mjs          # 只顯示將被刪除的內容（不會動資料）
 *   node scripts/reset-account.mjs --yes    # 實際執行
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');
const CONFIRMED = process.argv.includes('--yes');

const COUNTED_TABLES = [
  'users',
  'refresh_tokens',
  'subjects',
  'chapters',
  'question_groups',
  'questions',
  'question_options',
  'question_versions',
  'import_batches',
  'import_questions',
];

function readDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (!existsSync(ENV_PATH)) throw new Error('找不到 .env，且環境變數 DATABASE_URL 未設定。');
  const value = readFileSync(ENV_PATH, 'utf8').match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim();
  if (!value) throw new Error('DATABASE_URL 未設定。');
  return value;
}

async function counts(client) {
  const result = {};
  for (const table of COUNTED_TABLES) {
    const { rows } = await client.query(`select count(*)::int as n from ${table}`);
    result[table] = rows[0].n;
  }
  return result;
}

async function main() {
  const client = new pg.Client({ connectionString: readDatabaseUrl() });
  await client.connect();

  try {
    const { rows: users } = await client.query(
      'select username, display_name, created_at from users order by created_at',
    );

    if (users.length === 0) {
      console.log('[reset] 目前沒有任何帳號，系統已處於可初始化狀態。');
      return;
    }

    const before = await counts(client);

    console.log('[reset] 將被刪除的內容：');
    for (const user of users) {
      console.log(`  帳號：${user.username}${user.display_name ? `（${user.display_name}）` : ''}`);
    }
    for (const [table, n] of Object.entries(before)) {
      if (n > 0) console.log(`  ${table.padEnd(18)} ${n} 筆`);
    }

    if (!CONFIRMED) {
      console.log('\n[reset] 這是預覽模式，尚未刪除任何資料。');
      console.log('[reset] 確認無誤後請執行：node scripts/reset-account.mjs --yes\n');
      return;
    }

    await client.query('BEGIN');
    // 刪除使用者即可連帶清除其所有題庫資料（ON DELETE CASCADE）。
    await client.query('DELETE FROM users');
    // 這一行是關鍵：移除旗標後，首次初始化頁面才會重新開放。
    await client.query("DELETE FROM app_settings WHERE key = 'setup.completed'");
    await client.query('COMMIT');

    const after = await counts(client);
    console.log('\n[reset] 已刪除。目前剩餘：');
    for (const [table, n] of Object.entries(after)) {
      console.log(`  ${table.padEnd(18)} ${n} 筆`);
    }
    console.log('\n[reset] 初始化頁面已重新開放，請到前端 /setup 建立新帳號。');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  // 只印訊息，避免把含密碼的連線字串寫進 log。
  console.error(`[reset] 執行失敗：${error.message}`);
  process.exit(1);
});
