import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

export interface CreateDatabaseOptions {
  /** PostgreSQL 連線字串。呼叫端負責從已驗證的環境變數取得。 */
  connectionString: string;
  /** 連線池上限。單一使用者情境不需要太大。 */
  max?: number;
  /** 取得連線的逾時（毫秒）。 */
  connectionTimeoutMillis?: number;
}

export interface DatabaseHandle {
  db: Database;
  pool: Pool;
  close: () => Promise<void>;
}

/**
 * 建立資料庫連線。
 *
 * 刻意不在此讀取 process.env：環境變數一律由 @repo/contracts 的 validateEnv 驗證後注入，
 * 避免未驗證的設定散落到各處。
 */
export function createDatabase(options: CreateDatabaseOptions): DatabaseHandle {
  const poolConfig: PoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
  };

  const pool = new Pool(poolConfig);
  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}

/** 健康檢查用：確認資料庫可連線。回傳往返毫秒數。 */
export async function pingDatabase(pool: Pool): Promise<number> {
  const startedAt = performance.now();
  await pool.query('SELECT 1');
  return Math.round(performance.now() - startedAt);
}
