import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { createdAt, timestamps } from './_shared';
import { users } from './identity';
import { questions, subjects } from './question-bank';

/**
 * 受控標籤系統（docs/ERD.md §5）。
 *
 * 規格 §8 的核心訴求：**標籤不得由 AI 自由生成**，避免同義詞失控。
 * 因此三類詞彙都是資料表而非 enum —— 可以新增、改名、合併、停用，
 * 而 AI 只能「挑選既有的」或「提交建議」，沒有直接寫入的路徑。
 */

/** 知識點。使用者自建，可限定科目、可建階層。 */
export const knowledgeTags = pgTable(
  'knowledge_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** null 代表跨科目通用。 */
    subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** 正規化後的名稱（去空白、轉小寫、全形轉半形），唯一性以此為準。 */
    slug: text('slug').notNull(),
    description: text('description'),
    // 自我參照需要明確標註 AnyPgColumn，否則 drizzle 會靜默地不產生外鍵約束。
    parentId: uuid('parent_id').references((): AnyPgColumn => knowledgeTags.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('active'),
    // restrict：合併目標不可被直接刪除，否則已合併的標籤會指向不存在的列。
    mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => knowledgeTags.id, {
      onDelete: 'restrict',
    }),
    ...timestamps,
  },
  (t) => [
    check('knowledge_tags_status_check', sql`${t.status} in ('active', 'deprecated', 'merged')`),
    // merged 的標籤必須指向合併目標，其餘狀態則不得有目標 —— 由資料庫擋住不一致的狀態。
    check(
      'knowledge_tags_merged_target_check',
      sql`(${t.status} = 'merged') = (${t.mergedIntoId} is not null)`,
    ),
    check('knowledge_tags_no_self_merge_check', sql`${t.mergedIntoId} is null or ${t.mergedIntoId} <> ${t.id}`),
    check('knowledge_tags_no_self_parent_check', sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`),
    // 已合併的標籤保留原名不佔用唯一性，讓同名標籤日後可以重建。
    uniqueIndex('knowledge_tags_scope_slug_unique')
      .on(t.userId, t.subjectId, t.slug)
      .where(sql`status <> 'merged' and subject_id is not null`),
    uniqueIndex('knowledge_tags_global_slug_unique')
      .on(t.userId, t.slug)
      .where(sql`status <> 'merged' and subject_id is null`),
    index('knowledge_tags_user_status_idx').on(t.userId, t.status),
    index('knowledge_tags_parent_idx').on(t.parentId),
  ],
);

/**
 * 能力類型。系統預設 6 種（FR-TAG-04），由種子資料建立。
 *
 * 沒有 user_id：這是單一使用者系統，且能力類型屬於診斷詞彙而非個人資料。
 */
export const skillTags = pgTable(
  'skill_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    status: text('status').notNull().default('active'),
    ...timestamps,
  },
  (t) => [
    check('skill_tags_status_check', sql`${t.status} in ('active', 'deprecated', 'merged')`),
    unique('skill_tags_slug_unique').on(t.slug),
  ],
);

/**
 * 錯誤類型。系統預設 8 種（FR-TAG-05），由種子資料建立。
 *
 * `code` 是穩定識別碼：使用者可以改 `name`，但種子邏輯與 AI prompt 一律以 code 為準，
 * 改名才不會讓既有資料對不上。
 */
export const errorTypes = pgTable(
  'error_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    status: text('status').notNull().default('active'),
    /**
     * 「無法判定」。AI 判斷不出錯因時必須有合法選項可選，
     * 否則會被迫從具體選項中亂猜一個，產生看似明確實則無根據的診斷。
     */
    isFallback: boolean('is_fallback').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    check('error_types_status_check', sql`${t.status} in ('active', 'deprecated', 'merged')`),
    unique('error_types_code_unique').on(t.code),
    // 只能有一個 fallback，否則「判斷不出來時該選哪個」就沒有唯一答案。
    uniqueIndex('error_types_single_fallback_unique')
      .on(t.isFallback)
      .where(sql`is_fallback = true`),
  ],
);

/**
 * 題目 ↔ 知識點。
 *
 * 主要知識點最多 1 個由部分唯一索引在**資料庫層**保證（FR-TAG-02）；
 * 次要最多 2 個屬跨列計數，不適合寫成 DB 約束，由 contract 的 max(2) 與 service 檢查把關。
 */
export const questionKnowledgeTags = pgTable(
  'question_knowledge_tags',
  {
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    knowledgeTagId: uuid('knowledge_tag_id')
      .notNull()
      .references(() => knowledgeTags.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    source: text('source').notNull().default('manual'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.questionId, t.knowledgeTagId] }),
    check('question_knowledge_tags_role_check', sql`${t.role} in ('primary', 'secondary')`),
    check('question_knowledge_tags_source_check', sql`${t.source} in ('manual', 'ai', 'import')`),
    uniqueIndex('question_knowledge_tags_primary_unique')
      .on(t.questionId)
      .where(sql`role = 'primary'`),
    index('question_knowledge_tags_tag_idx').on(t.knowledgeTagId),
  ],
);

/** 題目 ↔ 能力類型。結構與知識點相同，主要 1 個同樣由部分唯一索引保證（FR-TAG-03）。 */
export const questionSkillTags = pgTable(
  'question_skill_tags',
  {
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    skillTagId: uuid('skill_tag_id')
      .notNull()
      .references(() => skillTags.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    source: text('source').notNull().default('manual'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.questionId, t.skillTagId] }),
    check('question_skill_tags_role_check', sql`${t.role} in ('primary', 'secondary')`),
    check('question_skill_tags_source_check', sql`${t.source} in ('manual', 'ai', 'import')`),
    uniqueIndex('question_skill_tags_primary_unique')
      .on(t.questionId)
      .where(sql`role = 'primary'`),
    index('question_skill_tags_tag_idx').on(t.skillTagId),
  ],
);

/**
 * 別名。把相似寫法映射到 canonical tag（FR-TAG-09）。
 *
 * 沒有外鍵指向具體的標籤表，因為 canonical_tag_id 依 tag_kind 指向三張不同的表。
 * 參照完整性由 service 在建立時驗證，並在合併／刪除標籤時一併維護。
 */
export const tagAliases = pgTable(
  'tag_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tagKind: text('tag_kind').notNull(),
    alias: text('alias').notNull(),
    /** 去空白、轉小寫、全形轉半形後的字串；比對一律用這個欄位。 */
    normalizedAlias: text('normalized_alias').notNull(),
    canonicalTagId: uuid('canonical_tag_id').notNull(),
    createdAt,
  },
  (t) => [
    check('tag_aliases_kind_check', sql`${t.tagKind} in ('knowledge', 'skill', 'error_type')`),
    unique('tag_aliases_kind_normalized_unique').on(t.userId, t.tagKind, t.normalizedAlias),
    index('tag_aliases_canonical_idx').on(t.canonicalTagId),
  ],
);

/**
 * 標籤建議（FR-TAG-07）。
 *
 * **這是 AI 唯一能碰到標籤系統的地方**：找不到合適的既有標籤時只能寫入這裡，
 * 由人審核後才可能變成正式標籤。狀態流轉 pending → approved / merged / rejected。
 */
export const tagSuggestions = pgTable(
  'tag_suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tagKind: text('tag_kind').notNull(),
    suggestedName: text('suggested_name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    contextQuestionId: uuid('context_question_id').references(() => questions.id, {
      onDelete: 'set null',
    }),
    source: text('source').notNull().default('user'),
    rationale: text('rationale'),
    // resolved_tag_id 與 tag_aliases.canonical_tag_id 同理：依 tag_kind 指向三張不同的表，
    // 無法用單一外鍵表達，由 service 在裁決時驗證。
    /** 同一個名稱重複被建議的次數，讓真正需要的標籤自然浮上來。 */
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    status: text('status').notNull().default('pending'),
    resolvedTagId: uuid('resolved_tag_id'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),
    ...timestamps,
  },
  (t) => [
    check('tag_suggestions_kind_check', sql`${t.tagKind} in ('knowledge', 'skill', 'error_type')`),
    check('tag_suggestions_source_check', sql`${t.source} in ('ai', 'user')`),
    check(
      'tag_suggestions_status_check',
      sql`${t.status} in ('pending', 'approved', 'merged', 'rejected')`,
    ),
    // 已處理的建議必須留下裁決時間，否則審核紀錄不完整。
    check(
      'tag_suggestions_reviewed_check',
      sql`(${t.status} = 'pending') = (${t.reviewedAt} is null)`,
    ),
    // 同一個名稱在待審期間只保留一筆，重複提交改為累加 occurrence_count。
    uniqueIndex('tag_suggestions_pending_unique')
      .on(t.userId, t.tagKind, t.normalizedName)
      .where(sql`status = 'pending'`),
    index('tag_suggestions_status_idx').on(t.userId, t.status),
  ],
);

/*
 * `mistake_record_error_types` 與 `mistake_records.last_error_type_id`
 * 定義在 quiz.ts，不在這裡。
 *
 * 兩者都需要外鍵指向本檔的 error_types，而錯題紀錄本身在 quiz.ts；
 * 若把關聯表放這裡，兩個 schema 檔就會互相 import 而形成循環。
 * 讓相依方向固定為 quiz.ts → tags.ts，drizzle-kit 與型別推導都不會出問題。
 */
