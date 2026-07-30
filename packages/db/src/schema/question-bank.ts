import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { createdAt, deletedAt, questionTypeEnum, timestamps } from './_shared';
import { users } from './identity';

/** 科目。題庫階層的最上層。 */
export const subjects = pgTable(
  'subjects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    code: text('code'),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    deletedAt,
    ...timestamps,
  },
  (t) => [
    // 部分唯一索引：軟刪除後同名科目可以重新建立。
    uniqueIndex('subjects_user_name_unique')
      .on(t.userId, t.name)
      .where(sql`deleted_at is null`),
    index('subjects_user_sort_idx').on(t.userId, t.sortOrder),
  ],
);

/** 章節。隸屬科目。 */
export const chapters = pgTable(
  'chapters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    deletedAt,
    ...timestamps,
  },
  (t) => [
    uniqueIndex('chapters_subject_name_unique')
      .on(t.subjectId, t.name)
      .where(sql`deleted_at is null`),
    index('chapters_subject_sort_idx').on(t.subjectId, t.sortOrder),
    // 這個唯一約束本身不是業務需求，而是為了讓 question_groups 能建立
    // (subject_id, chapter_id) 的複合外鍵 —— PostgreSQL 要求被參照的欄位組合具唯一性。
    unique('chapters_subject_id_id_unique').on(t.subjectId, t.id),
  ],
);

/**
 * 題組。隸屬科目；章節為選填。
 *
 * 關鍵設計：以複合外鍵 (subject_id, chapter_id) → chapters(subject_id, id)
 * 由「資料庫」保證章節必屬同一科目（FR-CAT-05）。
 * PostgreSQL 預設的 MATCH SIMPLE 在 chapter_id 為 NULL 時不檢查外鍵，
 * 正好允許「題組直接掛在科目下」（FR-CAT-03）。
 */
export const questionGroups = pgTable(
  'question_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    chapterId: uuid('chapter_id'),
    name: text('name').notNull(),
    description: text('description'),
    source: text('source'),
    year: integer('year'),
    notes: text('notes'),
    sortOrder: integer('sort_order').notNull().default(0),
    deletedAt,
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.subjectId, t.chapterId],
      foreignColumns: [chapters.subjectId, chapters.id],
      name: 'question_groups_chapter_within_subject_fk',
    }).onDelete('set null'),
    index('question_groups_subject_idx').on(t.subjectId, t.sortOrder),
    index('question_groups_chapter_idx').on(t.chapterId),
  ],
);

/** 題目。 */
export const questions = pgTable(
  'questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    questionGroupId: uuid('question_group_id')
      .notNull()
      .references(() => questionGroups.id, { onDelete: 'restrict' }),
    /** 反正規化，供列表篩選使用；由 service 在建立與移動時維持一致。 */
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    chapterId: uuid('chapter_id').references(() => chapters.id, { onDelete: 'set null' }),
    externalId: text('external_id'),
    questionNumber: integer('question_number').notNull(),
    type: questionTypeEnum('type').notNull(),
    stem: text('stem').notNull(),
    /** 允許為空。系統絕不自動編造解析（FR-Q-08）。 */
    explanation: text('explanation'),
    sourcePage: integer('source_page'),
    sourceReference: text('source_reference'),
    reviewRequired: boolean('review_required').notNull().default(false),
    reviewReason: text('review_reason'),
    status: text('status').notNull().default('active'),
    currentVersion: integer('current_version').notNull().default(1),
    /** sha256(正規化 stem + options + correctAnswers)。AI 快取失效的唯一判準。 */
    contentHash: text('content_hash').notNull(),
    deletedAt,
    ...timestamps,
  },
  (t) => [
    check('questions_status_check', sql`${t.status} in ('active', 'disputed', 'excluded')`),
    check('questions_question_number_check', sql`${t.questionNumber} > 0`),
    uniqueIndex('questions_group_number_unique')
      .on(t.questionGroupId, t.questionNumber)
      .where(sql`deleted_at is null`),
    uniqueIndex('questions_user_external_id_unique')
      .on(t.userId, t.externalId)
      .where(sql`external_id is not null and deleted_at is null`),
    index('questions_subject_status_idx').on(t.subjectId, t.status),
    index('questions_chapter_idx').on(t.chapterId),
    index('questions_group_idx').on(t.questionGroupId),
    index('questions_content_hash_idx').on(t.contentHash),
    index('questions_review_required_idx').on(t.reviewRequired),
  ],
);

/**
 * 選項。
 * 正確答案以 is_correct 布林欄位表達，而非 JSON 陣列 —— 可查詢、可加索引（docs/ERD.md §0.1）。
 */
export const questionOptions = pgTable(
  'question_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 4 }).notNull(),
    text: text('text').notNull(),
    isCorrect: boolean('is_correct').notNull().default(false),
    sortOrder: integer('sort_order').notNull(),
    createdAt,
  },
  (t) => [
    unique('question_options_question_key_unique').on(t.questionId, t.key),
    index('question_options_question_idx').on(t.questionId, t.sortOrder),
  ],
);

/** 題目版本快照。snapshot 存完整題目與選項，屬 JSONB 的正當用途（歷史快照）。 */
export const questionVersions = pgTable(
  'question_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    contentHash: text('content_hash').notNull(),
    changedFields: text('changed_fields').array(),
    changeReason: text('change_reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
  },
  (t) => [unique('question_versions_question_version_unique').on(t.questionId, t.version)],
);

/** 題目來源（PDF 頁碼、書目、URL 等）。 */
export const questionSources = pgTable(
  'question_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    label: text('label'),
    pageFrom: integer('page_from'),
    pageTo: integer('page_to'),
    url: text('url'),
    referenceText: text('reference_text'),
    createdAt,
  },
  (t) => [
    check('question_sources_kind_check', sql`${t.kind} in ('pdf', 'url', 'book', 'other')`),
    index('question_sources_question_idx').on(t.questionId),
  ],
);
