import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { createdAt, timestamps } from './_shared';

/**
 * 使用者。
 * 第一版只有一名使用者，但仍保留 user_id 關聯 —— 錯題與作答本質上屬於使用者，
 * 日後若要支援多人不必重構資料模型。
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  displayName: text('display_name'),
  /** argon2id 雜湊。明文密碼永不儲存。 */
  passwordHash: text('password_hash').notNull(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  ...timestamps,
});

/**
 * Refresh token（輪替機制的伺服器端狀態）。
 *
 * 規格未列出此表，但沒有伺服器端狀態就無法撤銷 token，也無法偵測重放，
 * 屬安全上的必要補充（docs/ERD.md §2）。
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 只存 SHA-256 雜湊：資料庫外洩也無法還原出可用的 token。 */
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** 輪替鏈：可偵測「已撤銷的 token 又被使用」這種竊取訊號。 */
    replacedById: uuid('replaced_by_id').references((): AnyPgColumn => refreshTokens.id, {
      onDelete: 'set null',
    }),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt,
  },
  (t) => [
    index('refresh_tokens_user_id_idx').on(t.userId),
    index('refresh_tokens_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * 系統設定。
 * value 因 key 而異，屬 JSONB 的正當用途。
 * 其中 `setup.completed` 是初始化頁面永久停用的依據（FR-AUTH-02）。
 */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  ...timestamps,
});
