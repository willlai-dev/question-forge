import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, timestamps } from './_shared';
import { users } from './identity';
import { chapters, questionGroups, questions, subjects } from './question-bank';

/**
 * 匯入批次。
 *
 * 核心原則：未驗證資料絕不進入 questions（FR-IMP-03）。
 * 所有上傳內容先落在本模組的暫存區，通過驗證並經人工確認後才寫入正式題庫。
 */
export const importBatches = pgTable(
  'import_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    fileSize: integer('file_size').notNull(),
    fileHash: text('file_hash').notNull(),
    schemaVersion: text('schema_version'),
    status: text('status').notNull().default('uploaded'),

    targetSubjectId: uuid('target_subject_id').references(() => subjects.id, {
      onDelete: 'set null',
    }),
    targetChapterId: uuid('target_chapter_id').references(() => chapters.id, {
      onDelete: 'set null',
    }),
    targetGroupId: uuid('target_group_id').references(() => questionGroups.id, {
      onDelete: 'set null',
    }),

    totalCount: integer('total_count').notNull().default(0),
    validCount: integer('valid_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    warningCount: integer('warning_count').notNull().default(0),
    reviewRequiredCount: integer('review_required_count').notNull().default(0),
    committedCount: integer('committed_count').notNull().default(0),
    /** 通過驗證的章節筆記數（schemaVersion 1.1.0 起）。 */
    noteCount: integer('note_count').notNull().default(0),

    /** 原始上傳內容，供追溯（FR-IMP-09）。 */
    rawPayload: jsonb('raw_payload').notNull(),
    errorSummary: jsonb('error_summary'),

    validatedAt: timestamp('validated_at', { withTimezone: true }),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check(
      'import_batches_status_check',
      sql`${t.status} in ('uploaded', 'validating', 'validated', 'partially_valid', 'failed', 'committing', 'committed', 'discarded')`,
    ),
    index('import_batches_user_created_idx').on(t.userId, t.createdAt),
    index('import_batches_status_idx').on(t.status),
  ],
);

/**
 * 匯入批次中的題組。
 *
 * 一個批次可以帶多個題組（同一科目的不同章節），來源有兩種：
 * 單一檔案內的 `questionGroups` 陣列（格式 1.2.0），或一次上傳多個舊格式檔案。
 * 兩種輸入都在驗證階段正規化成這張表，因此**後續流程只有一條路徑**。
 *
 * 每個題組各自判斷能不能 commit：使用者裁決「沒錯的先匯、有錯的擋下」。
 * 匯入 200 題只因為一題 OCR 有問題就全部卡住，不合理。
 */
export const importQuestionGroups = pgTable(
  'import_question_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    /** 在批次中的順序，同時是題目列回指的鍵。 */
    groupIndex: integer('group_index').notNull(),
    /** 多檔上傳時的來源檔名，讓使用者對得回是哪一份。 */
    sourceFilename: text('source_filename'),
    chapterName: text('chapter_name'),
    groupName: text('group_name').notNull(),
    source: text('source'),
    year: integer('year'),
    notes: text('notes'),
    /** 這個題組帶了幾段章節筆記。 */
    noteCount: integer('note_count').notNull().default(0),

    totalCount: integer('total_count').notNull().default(0),
    validCount: integer('valid_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    warningCount: integer('warning_count').notNull().default(0),
    committedCount: integer('committed_count').notNull().default(0),

    /** commit 之後指向實際建立的題組。 */
    resultingGroupId: uuid('resulting_group_id').references(() => questionGroups.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => [
    unique('import_question_groups_batch_index_unique').on(t.batchId, t.groupIndex),
    index('import_question_groups_batch_idx').on(t.batchId),
  ],
);

/**
 * 匯入暫存題目。
 *
 * options 與 correct_answers 以 jsonb 儲存：此階段的資料尚未通過驗證，
 * 結構可能不合法（例如選項不是陣列），無法套用正規化欄位。
 * 這正是 JSONB 的正當用途（docs/ERD.md §0.1）。
 */
export const importQuestions = pgTable(
  'import_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    /**
     * 所屬題組。
     *
     * 可為空只是為了相容這個欄位出現之前的舊批次（那些都已經是終端狀態）。
     * **新的批次一律有值**，commit 也只走有值的路徑——留一條 fallback
     * 等於讓同一件事有兩種寫法，遲早分岔。
     */
    importGroupId: uuid('import_group_id').references(() => importQuestionGroups.id, {
      onDelete: 'cascade',
    }),
    rowIndex: integer('row_index').notNull(),

    externalId: text('external_id'),
    questionNumber: integer('question_number'),
    type: text('type'),
    stem: text('stem'),
    options: jsonb('options'),
    correctAnswers: jsonb('correct_answers'),
    explanation: text('explanation'),
    sourcePage: integer('source_page'),
    sourceReference: text('source_reference'),
    reviewRequired: boolean('review_required').notNull().default(false),
    reviewReason: text('review_reason'),

    status: text('status').notNull().default('pending'),
    /** 使用者在預覽頁的修正內容（FR-IMP-05）。 */
    editedPayload: jsonb('edited_payload'),
    resultingQuestionId: uuid('resulting_question_id').references(() => questions.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => [
    check(
      'import_questions_status_check',
      sql`${t.status} in ('pending', 'valid', 'warning', 'error', 'excluded', 'fixed', 'committed')`,
    ),
    unique('import_questions_batch_row_unique').on(t.batchId, t.rowIndex),
    index('import_questions_batch_status_idx').on(t.batchId, t.status),
  ],
);

/** 驗證問題。錯誤碼清單見 docs/API_CONTRACT.md §5。 */
export const importValidationIssues = pgTable(
  'import_validation_issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    importQuestionId: uuid('import_question_id').references(() => importQuestions.id, {
      onDelete: 'cascade',
    }),
    level: text('level').notNull(),
    code: text('code').notNull(),
    fieldPath: text('field_path'),
    message: text('message').notNull(),
    details: jsonb('details'),
    createdAt,
  },
  (t) => [
    check('import_validation_issues_level_check', sql`${t.level} in ('error', 'warning')`),
    index('import_validation_issues_batch_level_idx').on(t.batchId, t.level),
    index('import_validation_issues_question_idx').on(t.importQuestionId),
  ],
);
