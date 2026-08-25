import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, timestamps } from './_shared';
import { users } from './identity';
import { questions } from './question-bank';
import { errorTypes } from './tags';

/**
 * 作答與錯題（docs/ERD.md §6）。
 *
 * `reveal_mode` 用 pgEnum：只有兩種模式，且再增加就會是產品層級的重新設計，屬真正封閉的集合。
 * 其餘狀態欄位用 text + CHECK，理由見 _shared.ts。
 */
export const revealModeEnum = pgEnum('reveal_mode', ['immediate', 'after_submit']);

/** 作答場次。 */
export const quizSessions = pgTable(
  'quiz_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull().default('practice'),
    orderStrategy: text('order_strategy').notNull().default('sequential'),
    shuffleOptions: boolean('shuffle_options').notNull().default(false),
    questionLimit: integer('question_limit'),
    revealMode: revealModeEnum('reveal_mode').notNull().default('immediate'),
    allowAnswerChange: boolean('allow_answer_change').notNull().default(true),
    status: text('status').notNull().default('in_progress'),
    /** 讓隨機出題與選項順序可重現；出題結果本身另存於 quiz_session_questions。 */
    seed: integer('seed').notNull(),
    totalQuestions: integer('total_questions').notNull().default(0),
    answeredCount: integer('answered_count').notNull().default(0),
    correctCount: integer('correct_count').notNull().default(0),
    score: numeric('score', { precision: 5, scale: 2 }),
    /**
     * 分數用什麼當分母。交卷時由使用者決定，寫進場次以保證日後重看時數字一致。
     *
     * `all_questions`：總題數，未作答視同答錯（模擬考的算法）。
     * `answered_only`：只算實際作答的題數，時間不夠提早交卷時用。
     *
     * 交卷前為 null——還沒交卷就沒有分數，也就沒有分母可言。
     */
    scoringMode: text('scoring_mode'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    /** 建立當下的完整設定，供日後回溯「這場是用什麼條件出的題」。 */
    configSnapshot: jsonb('config_snapshot').notNull(),
    ...timestamps,
  },
  (t) => [
    check(
      'quiz_sessions_mode_check',
      sql`${t.mode} in ('practice', 'mistake_review', 'knowledge_focus', 'exam')`,
    ),
    check(
      'quiz_sessions_order_strategy_check',
      sql`${t.orderStrategy} in ('sequential', 'random')`,
    ),
    check(
      'quiz_sessions_status_check',
      sql`${t.status} in ('in_progress', 'submitted', 'abandoned')`,
    ),
    check(
      'quiz_sessions_question_limit_check',
      sql`${t.questionLimit} is null or ${t.questionLimit} > 0`,
    ),
    check(
      'quiz_sessions_scoring_mode_check',
      sql`${t.scoringMode} is null or ${t.scoringMode} in ('all_questions', 'answered_only')`,
    ),
    // 交卷才有分數，有分數就一定要說得出分母。
    check(
      'quiz_sessions_scoring_mode_consistency_check',
      sql`(${t.score} is null) = (${t.scoringMode} is null)`,
    ),
    index('quiz_sessions_user_started_idx').on(t.userId, t.startedAt.desc()),
    index('quiz_sessions_user_status_idx').on(t.userId, t.status),
  ],
);

/**
 * 出題範圍。
 *
 * 刻意正規化成一張表而不是塞進 config_snapshot 的 jsonb ——
 * 之後才查得到「哪些場次練過這個題組」。
 */
export const quizSessionScopes = pgTable(
  'quiz_session_scopes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => quizSessions.id, { onDelete: 'cascade' }),
    scopeType: text('scope_type').notNull(),
    /** `mistake` 範圍沒有對應的 ref，故允許 NULL。 */
    refId: uuid('ref_id'),
    createdAt,
  },
  (t) => [
    // knowledge_tag 屬 Phase 3（FR-QUIZ-06）。CHECK 先納入該值，
    // 之後只要開放 API 即可，不必為了加一個字串再做一次結構遷移。
    check(
      'quiz_session_scopes_type_check',
      sql`${t.scopeType} in ('subject', 'chapter', 'question_group', 'knowledge_tag', 'mistake')`,
    ),
    unique('quiz_session_scopes_unique').on(t.sessionId, t.scopeType, t.refId),
    index('quiz_session_scopes_ref_idx').on(t.scopeType, t.refId),
  ],
);

/**
 * 場次中的單題。
 *
 * `option_order` 是選項隨機化的核心：前端只拿到這個顯示順序，
 * 使用者送回的是真實 key，判分比對 `correct_answers_snapshot`。
 * 顯示與判分因此完全解耦（docs/ERD.md §6）。
 */
export const quizSessionQuestions = pgTable(
  'quiz_session_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => quizSessions.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    optionOrder: text('option_order').array().notNull(),
    questionVersion: integer('question_version').notNull(),
    correctAnswersSnapshot: text('correct_answers_snapshot').array().notNull(),
    status: text('status').notNull().default('unanswered'),
    createdAt,
  },
  (t) => [
    check(
      'quiz_session_questions_status_check',
      sql`${t.status} in ('unanswered', 'answered', 'skipped')`,
    ),
    check('quiz_session_questions_position_check', sql`${t.position} > 0`),
    unique('quiz_session_questions_position_unique').on(t.sessionId, t.position),
    unique('quiz_session_questions_question_unique').on(t.sessionId, t.questionId),
    index('quiz_session_questions_question_idx').on(t.questionId),
  ],
);

/**
 * 作答紀錄。
 *
 * `correct_answers_snapshot` 在這裡「再存一份」而非只靠 quiz_session_questions：
 * 歷史紀錄必須自身完整，題目日後被修改或場次資料被清理都不影響（FR-QUIZ-13）。
 */
export const userAnswers = pgTable(
  'user_answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => quizSessions.id, { onDelete: 'cascade' }),
    sessionQuestionId: uuid('session_question_id')
      .notNull()
      .references(() => quizSessionQuestions.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    selectedAnswers: text('selected_answers').array().notNull(),
    correctAnswersSnapshot: text('correct_answers_snapshot').array().notNull(),
    isCorrect: boolean('is_correct').notNull(),
    /**
     * 答案爭議待審期間為 true，統計一律排除（FR-QUIZ-14）。
     * 欄位在 Phase 2 就建立並讓所有統計查詢過濾，Phase 4 只需負責把值設為 true。
     */
    isProvisional: boolean('is_provisional').notNull().default(false),
    responseTimeMs: integer('response_time_ms'),
    attemptNumber: integer('attempt_number').notNull().default(1),
    /** 交卷前改了幾次答案。修改答案不新增列，只更新本列並累加這個計數。 */
    answerChangedCount: integer('answer_changed_count').notNull().default(0),
    revealMode: revealModeEnum('reveal_mode').notNull(),
    questionVersion: integer('question_version').notNull(),
    answeredAt: timestamp('answered_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    unique('user_answers_attempt_unique').on(t.sessionQuestionId, t.attemptNumber),
    index('user_answers_user_question_idx').on(t.userId, t.questionId, t.answeredAt.desc()),
    index('user_answers_session_idx').on(t.sessionId),
    index('user_answers_diagnostic_idx')
      .on(t.userId, t.isCorrect)
      .where(sql`is_provisional = false`),
    // 多題分析一律以期間範圍掃描（Phase 5）。上面那個診斷索引不含 answered_at，
    // 服務不了範圍查詢。btree 兩個方向都能掃，所以 ASC 也涵蓋由新到舊的排序。
    index('user_answers_diagnostic_period_idx')
      .on(t.userId, t.answeredAt)
      .where(sql`is_provisional = false`),
  ],
);

/**
 * 錯題紀錄。
 *
 * 一題一列，答對不刪除（FR-MIS-05）。
 */
export const mistakeRecords = pgTable(
  'mistake_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'restrict' }),
    mistakeCount: integer('mistake_count').notNull().default(0),
    consecutiveCorrect: integer('consecutive_correct').notNull().default(0),
    totalAttempts: integer('total_attempts').notNull().default(0),
    recentAccuracy: numeric('recent_accuracy', { precision: 5, scale: 4 }),
    masteryState: text('mastery_state').notNull().default('active'),
    firstMissedAt: timestamp('first_missed_at', { withTimezone: true }),
    lastMissedAt: timestamp('last_missed_at', { withTimezone: true }),
    lastAnsweredAt: timestamp('last_answered_at', { withTimezone: true }),
    /** 最近一次判定的錯誤類型。完整清單在 mistake_record_error_types。 */
    lastErrorTypeId: uuid('last_error_type_id').references(() => errorTypes.id, {
      onDelete: 'set null',
    }),
    /** 是否曾經重新答對過；一旦為 true 就不再變回 false。 */
    isResolved: boolean('is_resolved').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    check(
      'mistake_records_mastery_state_check',
      sql`${t.masteryState} in ('active', 'improving', 'mastered')`,
    ),
    // 連續答對 0 次必為 active、≥3 次必為 mastered，其餘為 improving。
    // 由資料庫直接鎖住 computeMasteryState() 的規則，避免任何寫入路徑繞過它。
    check(
      'mistake_records_mastery_consistency_check',
      sql`${t.masteryState} = case
            when ${t.consecutiveCorrect} <= 0 then 'active'
            when ${t.consecutiveCorrect} < 3 then 'improving'
            else 'mastered'
          end`,
    ),
    uniqueIndex('mistake_records_user_question_unique').on(t.userId, t.questionId),
    index('mistake_records_user_state_idx').on(t.userId, t.masteryState),
    index('mistake_records_user_last_missed_idx').on(t.userId, t.lastMissedAt.desc()),
  ],
);

/**
 * 錯題 ↔ 錯誤類型（FR-MIS-02）。
 *
 * 本表原列於 Phase 2，但需要外鍵指向 Phase 3 的 error_types，因此隨該表一起建立。
 * 放在本檔而非 tags.ts，是為了讓 schema 檔的相依方向固定為 quiz.ts → tags.ts，避免循環 import。
 */
export const mistakeRecordErrorTypes = pgTable(
  'mistake_record_error_types',
  {
    mistakeRecordId: uuid('mistake_record_id')
      .notNull()
      .references(() => mistakeRecords.id, { onDelete: 'cascade' }),
    errorTypeId: uuid('error_type_id')
      .notNull()
      .references(() => errorTypes.id, { onDelete: 'restrict' }),
    /**
     * 這一題因為這個錯誤類型而答錯的「已分析次數」。
     *
     * Phase 5 起才真正遞增，且只由 AI 分析路徑遞增（見 QuestionAnalysisService.markErrorType）：
     * 手動標記是「取代」語意，重複按儲存不該被當成又錯了一次。
     * Phase 5 之前寫入的列一律停在 1，那是一致的低估，不做回填——
     * 手動標記的真實歷史無法還原，部分回填只會讓兩種來源的數字失去可比性。
     */
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    /** manual：使用者自行標記；ai：Phase 4 的分析結果。 */
    source: text('source').notNull().default('manual'),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.mistakeRecordId, t.errorTypeId] }),
    check('mistake_record_error_types_source_check', sql`${t.source} in ('manual', 'ai')`),
    check('mistake_record_error_types_occurrence_check', sql`${t.occurrenceCount} > 0`),
    index('mistake_record_error_types_error_idx').on(t.errorTypeId),
  ],
);
