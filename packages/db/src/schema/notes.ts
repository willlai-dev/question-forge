import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { deletedAt, timestamps } from './_shared';
import { users } from './identity';
import { importBatches } from './import';
import { chapters, questionGroups, questions, subjects } from './question-bank';

/**
 * 章節筆記。
 *
 * 使用者的單章 PDF 通常同時含有題目與筆記；筆記隨題目一起匯入後，
 * 成為該題庫**本地的資料源**——比網路搜尋精準，而且不消耗 API 額度。
 *
 * 與 `web_documents` 是同一個角色：持久保存的正文來源。
 * 兩者都在分析時被複製成 `question_evidence_sources` 的一筆快照（S1、S2…），
 * 因此**筆記自動繼承既有的全部引用防護**——包括「quote 必須逐字出自來源」。
 * AI 不能捏造你筆記裡沒寫過的話。
 */
export const studyNotes = pgTable(
  'study_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    chapterId: uuid('chapter_id').references(() => chapters.id, { onDelete: 'set null' }),
    /**
     * 所屬題組。
     *
     * 檢索的預設範圍就是題組——單章 PDF 匯入一次就是一個題組，
     * 同一份文件裡的筆記與題目本來就該互相看得見。
     */
    questionGroupId: uuid('question_group_id')
      .notNull()
      .references(() => questionGroups.id, { onDelete: 'cascade' }),
    importBatchId: uuid('import_batch_id').references(() => importBatches.id, {
      onDelete: 'set null',
    }),
    /** 匯入檔案中的識別（例如 N1）。題目靠它建立關聯。 */
    noteKey: text('note_key').notNull(),
    title: text('title'),
    content: text('content').notNull(),
    sourcePage: integer('source_page'),
    /** 檢索用關鍵字。缺了也還有正文可比對，因此不設為必填。 */
    keywords: text('keywords').array().notNull().default(sql`'{}'::text[]`),
    /** sha256(正規化 content)。折進 AI 快取判準，筆記改了舊解析才會失效。 */
    contentHash: text('content_hash').notNull(),
    deletedAt,
    ...timestamps,
  },
  (t) => [
    check('study_notes_content_check', sql`length(${t.content}) > 0`),
    // 同一個題組內 noteKey 不重複；軟刪除後可以再匯入同一個 key。
    uniqueIndex('study_notes_group_key_unique')
      .on(t.questionGroupId, t.noteKey)
      .where(sql`deleted_at is null`),
    index('study_notes_group_idx').on(t.questionGroupId),
    index('study_notes_subject_idx').on(t.subjectId),
    index('study_notes_chapter_idx').on(t.chapterId),
  ],
);

/**
 * 題目與筆記的明確關聯（匯入檔的 `relatedNoteIds`）。
 *
 * 有明確關聯時檢索直接採用，不必猜；沒有的話才退回關鍵字比對。
 * 這張表存在的意義是「使用者說了算」優先於「程式猜的」。
 */
export const questionNoteLinks = pgTable(
  'question_note_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    studyNoteId: uuid('study_note_id')
      .notNull()
      .references(() => studyNotes.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('question_note_links_unique').on(t.questionId, t.studyNoteId),
    index('question_note_links_question_idx').on(t.questionId),
  ],
);
