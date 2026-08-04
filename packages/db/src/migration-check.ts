import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Pool } from 'pg';

/**
 * 啟動時的 migration 落後檢查。
 *
 * 起因是一次真實的失敗：加了 0005（新增 study_notes）之後，應用照樣啟動成功，
 * 直到使用者按下「AI 分析」才在 runtime 爆出
 * `relation "study_notes" does not exist` 的 500——那個訊息對使用者毫無意義，
 * 而且問題其實在啟動之前就已經確定存在了。
 *
 * 設計原則與既有的環境變數驗證一致：**設定有問題就不要讓服務半殘地起來。**
 * 半殘的服務比起不來更糟——它會在無法預測的時間點、以無法理解的訊息壞掉。
 */

/** drizzle-kit 的 journal 結構，只取需要的欄位。 */
interface MigrationJournal {
  entries: { idx: number; tag: string }[];
}

export class PendingMigrationsError extends Error {
  constructor(
    readonly applied: number,
    readonly expected: number,
    readonly pendingTags: string[],
  ) {
    super(
      `資料庫有 ${expected - applied} 筆 migration 尚未套用（已套用 ${applied} / 應有 ${expected}）。` +
        `\n未套用：${pendingTags.join('、')}`,
    );
    this.name = 'PendingMigrationsError';
  }
}

/**
 * 比對 journal 與資料庫已套用的 migration 數量。
 *
 * 刻意只比**數量**而不逐筆比對 hash：drizzle 存的是檔案內容的 hash，
 * 而本專案會在產生後手動加註解（見 0004、0005 的檔頭），hash 必然對不上。
 * 數量足以抓到「忘了跑 migration」這個唯一真正會發生的情境。
 *
 * 資料庫還沒有 migration 表時視為「一筆都沒套用」——全新安裝的正常起點，
 * 由呼叫端決定要不要擋（此時 expected > 0 會擋下，訊息同樣是叫人去跑 migrate）。
 */
export async function assertMigrationsUpToDate(pool: Pool): Promise<void> {
  const journal = readJournal();
  if (journal === null) return;

  const expected = journal.entries.length;
  if (expected === 0) return;

  const applied = await countApplied(pool);
  if (applied >= expected) return;

  // journal 依 idx 排序，落後的就是尾端那幾筆。
  const pending = [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .slice(applied)
    .map((entry) => entry.tag);

  throw new PendingMigrationsError(applied, expected, pending);
}

function readJournal(): MigrationJournal | null {
  // dist/ 與 drizzle/ 是同一層的兄弟目錄（package.json 的 files 包含 drizzle）。
  const path = join(__dirname, '..', 'drizzle', 'meta', '_journal.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as MigrationJournal;
  } catch {
    // 讀不到 journal 就不要因此擋住啟動——這個檢查是護欄，不是核心功能。
    return null;
  }
}

async function countApplied(pool: Pool): Promise<number> {
  try {
    const result = await pool.query<{ count: string }>(
      'select count(*)::text as count from drizzle.__drizzle_migrations',
    );
    return Number(result.rows[0]?.count ?? 0);
  } catch {
    // 表不存在 = 一筆都還沒套用。
    return 0;
  }
}
