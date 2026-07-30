import { pgEnum, timestamp } from 'drizzle-orm/pg-core';

/**
 * 共通欄位與列舉。
 *
 * 列舉策略（見 docs/ERD.md §0.3）：
 *   - 真正封閉的集合用 pgEnum。
 *   - 可能演進的狀態欄位用 text + CHECK，避免 ALTER TYPE ADD VALUE 無法在交易內執行的問題。
 */

/** 題型。第一版只支援選擇題，且短期內不會擴充，適合用 pgEnum。 */
export const questionTypeEnum = pgEnum('question_type', ['single_choice', 'multiple_choice']);

/** 建立時間（所有資料表皆有）。 */
export const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** 建立與更新時間（可變更的資料表）。 */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** 軟刪除標記。歷史作答紀錄永遠指向題目，因此不做硬刪除（docs/ERD.md §0.2）。 */
export const deletedAt = timestamp('deleted_at', { withTimezone: true });
