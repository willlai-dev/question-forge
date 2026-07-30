import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';
import { resolve } from 'node:path';

// 環境變數統一放在 repo 根目錄的 .env，不在各 package 各自維護一份。
config({ path: resolve(__dirname, '../../.env') });

const url = process.env.DATABASE_URL;
if (!url) {
  // 只印鍵名，不印值。
  throw new Error('缺少必要環境變數 DATABASE_URL，請先執行 pnpm bootstrap:env 並填入該值。');
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  // 遷移一律以檔案產生，禁止直接改動資料庫結構（prompt.md §20.20）。
  strict: true,
  verbose: true,
});
