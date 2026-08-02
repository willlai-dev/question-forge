import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, timestamps } from './_shared';
import { users } from './identity';
import { questions } from './question-bank';
import { userAnswers } from './quiz';
import { errorTypes, knowledgeTags } from './tags';

/**
 * AI 分析相關資料表（docs/ERD.md §7）。
 *
 * 貫穿本檔的原則：**AI 的輸出永遠先落地成可稽核的資料，再由程式決定要不要採用。**
 * 原始輸出保存在 `raw_output`，引用必須指向實際存在的來源，
 * 質疑題庫答案只能產生待審爭議而不能直接改答案。
 */

/** Prompt 版本。內容以檔案維護（進版控），啟動時 seed 進資料庫。 */
export const promptVersions = pgTable(
  'prompt_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operation: text('operation').notNull(),
    version: text('version').notNull(),
    systemPrompt: text('system_prompt').notNull(),
    userTemplate: text('user_template').notNull(),
    outputSchema: jsonb('output_schema'),
    modelDefaults: jsonb('model_defaults'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    check(
      'prompt_versions_operation_check',
      sql`${t.operation} in ('research_plan', 'evidence_synthesis', 'final_explanation', 'aggregate_analysis')`,
    ),
    unique('prompt_versions_operation_version_unique').on(t.operation, t.version),
    // 每個階段同時只能有一個啟用版本，否則「目前用哪個 prompt」沒有唯一答案。
    uniqueIndex('prompt_versions_active_unique')
      .on(t.operation)
      .where(sql`is_active = true`),
  ],
);

/** AI 任務。狀態與進度都寫進 PostgreSQL，前端輪詢這裡而不是問 BullMQ。 */
export const aiJobs = pgTable(
  'ai_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobType: text('job_type').notNull(),
    queue: text('queue').notNull(),
    bullmqJobId: text('bullmq_job_id'),
    /**
     * 同時作為 BullMQ 的 jobId。
     * 資料庫唯一約束與佇列去重雙重保證同一任務不會重複執行（規格 §14）。
     */
    idempotencyKey: text('idempotency_key').notNull(),
    questionId: uuid('question_id').references(() => questions.id, { onDelete: 'cascade' }),
    userAnswerId: uuid('user_answer_id').references(() => userAnswers.id, { onDelete: 'set null' }),
    targetRef: jsonb('target_ref'),
    status: text('status').notNull().default('pending'),
    progressStep: text('progress_step').notNull().default('QUEUED'),
    progressPct: integer('progress_pct').notNull().default(0),
    priority: integer('priority').notNull().default(2),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    /** 命中快取而直接完成，完全沒有呼叫模型。 */
    servedFromCache: boolean('served_from_cache').notNull().default(false),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check(
      'ai_jobs_type_check',
      sql`${t.jobType} in ('question_analysis', 'aggregate_analysis', 'maintenance')`,
    ),
    check(
      'ai_jobs_status_check',
      sql`${t.status} in ('pending', 'active', 'completed', 'failed', 'retrying', 'cancelled')`,
    ),
    check('ai_jobs_priority_check', sql`${t.priority} between 1 and 4`),
    check('ai_jobs_progress_check', sql`${t.progressPct} between 0 and 100`),
    unique('ai_jobs_idempotency_key_unique').on(t.idempotencyKey),
    index('ai_jobs_user_status_idx').on(t.userId, t.status),
    index('ai_jobs_created_idx').on(t.createdAt.desc()),
    index('ai_jobs_question_idx').on(t.questionId),
  ],
);

/** AI 呼叫的用量與結果紀錄。規格 §二逐條要求的欄位全部落表。 */
export const aiUsageLogs = pgTable(
  'ai_usage_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aiJobId: uuid('ai_job_id').references(() => aiJobs.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version'),
    requestStatus: text('request_status').notNull(),
    httpStatus: integer('http_status'),
    latencyMs: integer('latency_ms'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    totalTokens: integer('total_tokens'),
    /** 一併記錄，日後可用實際數據回頭調整三階段的設定。 */
    reasoningEffort: text('reasoning_effort'),
    finishReason: text('finish_reason'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').notNull().default(0),
    attemptIndex: integer('attempt_index').notNull().default(0),
    createdAt,
  },
  (t) => [
    check(
      'ai_usage_logs_status_check',
      sql`${t.requestStatus} in ('success', 'schema_invalid', 'semantic_invalid', 'rate_limited', 'http_error', 'timeout', 'cancelled')`,
    ),
    index('ai_usage_logs_created_idx').on(t.createdAt.desc()),
    index('ai_usage_logs_operation_status_idx').on(t.operation, t.requestStatus),
    index('ai_usage_logs_user_idx').on(t.userId),
  ],
);

/** 跨題重用的正文快取。永久資料不可只存 Redis，因此另有這張表。 */
export const webDocuments = pgTable(
  'web_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    urlHash: text('url_hash').notNull(),
    url: text('url').notNull(),
    domain: text('domain').notNull(),
    title: text('title'),
    extractedText: text('extracted_text'),
    contentLength: integer('content_length'),
    httpStatus: integer('http_status'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    unique('web_documents_url_hash_unique').on(t.urlHash),
    index('web_documents_expires_idx').on(t.expiresAt),
  ],
);

/** 一次研究的證據集合（AI#1 規劃 + 程式搜尋 + AI#2 整理的結果）。 */
export const questionEvidenceSets = pgTable(
  'question_evidence_sets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    aiJobId: uuid('ai_job_id').references(() => aiJobs.id, { onDelete: 'set null' }),
    researchMode: text('research_mode').notNull(),
    /** AI#1 的原始輸出。 */
    plan: jsonb('plan'),
    queries: jsonb('queries'),
    evidenceSummary: text('evidence_summary'),
    supportedClaims: jsonb('supported_claims'),
    contradictedClaims: jsonb('contradicted_claims'),
    conflicts: jsonb('conflicts'),
    insufficientEvidence: boolean('insufficient_evidence').notNull().default(false),
    recommendedAnswers: text('recommended_answers').array(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    requiresHumanReview: boolean('requires_human_review').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check(
      'question_evidence_sets_mode_check',
      sql`${t.researchMode} in ('MODEL_ONLY', 'PDF_KNOWLEDGE', 'WEB_RESEARCH', 'HYBRID')`,
    ),
    index('question_evidence_sets_question_idx').on(t.questionId),
  ],
);

/**
 * 證據來源。
 *
 * `(evidence_set_id, source_id)` 唯一是「AI 引用只能指向實際存在來源」的資料庫基礎
 * （驗收標準 #16）：`source_id` 由程式指派（S1、S2…），
 * 儲存前驗證 AI 的 citations ⊆ 本集合，AI 因此無法憑空產生 URL。
 */
export const questionEvidenceSources = pgTable(
  'question_evidence_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    evidenceSetId: uuid('evidence_set_id')
      .notNull()
      .references(() => questionEvidenceSets.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull(),
    url: text('url').notNull(),
    domain: text('domain').notNull(),
    title: text('title').notNull(),
    publishedDate: text('published_date'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    contentSnippet: text('content_snippet'),
    contentLength: integer('content_length'),
    searchProvider: text('search_provider'),
    searchQuery: text('search_query'),
    rank: integer('rank'),
    score: numeric('score', { precision: 6, scale: 4 }),
    trustTier: text('trust_tier').notNull().default('other'),
    isUsed: boolean('is_used').notNull().default(false),
    createdAt,
  },
  (t) => [
    check(
      'question_evidence_sources_trust_tier_check',
      sql`${t.trustTier} in ('official', 'academic', 'educational', 'reference', 'other')`,
    ),
    unique('question_evidence_sources_set_source_unique').on(t.evidenceSetId, t.sourceId),
    index('question_evidence_sources_set_idx').on(t.evidenceSetId),
  ],
);

/** 題目層級的通用解析（與使用者答案無關，可跨次重用）。 */
export const questionAiEnrichments = pgTable(
  'question_ai_enrichments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    /** 產生當下的題目內容雜湊。與現值不符即代表快取失效（規格 §12）。 */
    questionContentHash: text('question_content_hash').notNull(),
    evidenceSetId: uuid('evidence_set_id').references(() => questionEvidenceSets.id, {
      onDelete: 'set null',
    }),
    promptVersionPlan: text('prompt_version_plan'),
    promptVersionEvidence: text('prompt_version_evidence'),
    promptVersionFinal: text('prompt_version_final'),
    model: text('model').notNull(),
    researchMode: text('research_mode').notNull(),
    canonicalExplanation: text('canonical_explanation'),
    coreConcept: text('core_concept'),
    solutionSteps: jsonb('solution_steps'),
    optionAnalysis: jsonb('option_analysis'),
    answerValidation: jsonb('answer_validation'),
    primaryKnowledgeTagId: uuid('primary_knowledge_tag_id').references(() => knowledgeTags.id, {
      onDelete: 'set null',
    }),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    requiresHumanReview: boolean('requires_human_review').notNull().default(false),
    /** 模型的原始輸出，供除錯與事後稽核。 */
    rawOutput: jsonb('raw_output'),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    isCurrent: boolean('is_current').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    // 一題一份現行解析，舊版保留不刪。
    uniqueIndex('question_ai_enrichments_current_unique')
      .on(t.questionId)
      .where(sql`is_current = true`),
    index('question_ai_enrichments_question_idx').on(t.questionId),
    index('question_ai_enrichments_hash_idx').on(t.questionContentHash),
  ],
);

/** 使用者層級的個人化錯因分析。同一題同一種錯法只分析一次。 */
export const personalizedMistakeAnalyses = pgTable(
  'personalized_mistake_analyses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    userAnswerId: uuid('user_answer_id').references(() => userAnswers.id, { onDelete: 'set null' }),
    /** sha256(questionId + questionVersion + selectedAnswers + correctAnswers + promptVersion + model) */
    cacheKey: text('cache_key').notNull(),
    selectedAnswers: text('selected_answers').array().notNull(),
    correctAnswers: text('correct_answers').array().notNull(),
    questionVersion: integer('question_version').notNull(),
    promptVersion: text('prompt_version'),
    model: text('model').notNull(),
    userWasCorrect: boolean('user_was_correct').notNull().default(false),
    whyWrong: text('why_wrong'),
    missedConditions: jsonb('missed_conditions'),
    errorTypeId: uuid('error_type_id').references(() => errorTypes.id, { onDelete: 'set null' }),
    reviewSuggestions: jsonb('review_suggestions'),
    citations: jsonb('citations'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    requiresHumanReview: boolean('requires_human_review').notNull().default(false),
    rawOutput: jsonb('raw_output'),
    ...timestamps,
  },
  (t) => [
    unique('personalized_mistake_analyses_cache_key_unique').on(t.cacheKey),
    index('personalized_mistake_analyses_user_question_idx').on(t.userId, t.questionId),
  ],
);

/**
 * 答案衝突。
 *
 * **AI 永遠不會自己改答案**（規格 §10）——它只能產生這裡的一筆待審紀錄。
 * 待審期間題目狀態轉為 disputed、新的作答標記 is_provisional，統計一律排除，
 * 直接滿足驗收標準 #18。
 */
export const answerConflicts = pgTable(
  'answer_conflicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    evidenceSetId: uuid('evidence_set_id').references(() => questionEvidenceSets.id, {
      onDelete: 'set null',
    }),
    aiJobId: uuid('ai_job_id').references(() => aiJobs.id, { onDelete: 'set null' }),
    storedAnswers: text('stored_answers').array().notNull(),
    verifiedAnswers: text('verified_answers').array().notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    conflictReason: text('conflict_reason').notNull(),
    evidence: jsonb('evidence'),
    sourceIds: text('source_ids').array(),
    requiresReview: boolean('requires_review').notNull().default(true),
    reviewStatus: text('review_status').notNull().default('pending'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    check(
      'answer_conflicts_review_status_check',
      sql`${t.reviewStatus} in ('pending', 'kept_original', 'answer_updated', 'explanation_updated', 'marked_disputed', 'question_excluded')`,
    ),
    check(
      'answer_conflicts_reviewed_check',
      sql`(${t.reviewStatus} = 'pending') = (${t.reviewedAt} is null)`,
    ),
    // 同一題不累積重複的待審爭議。
    uniqueIndex('answer_conflicts_pending_unique')
      .on(t.questionId)
      .where(sql`review_status = 'pending'`),
    index('answer_conflicts_status_idx').on(t.reviewStatus),
  ],
);

/**
 * 多題整合分析（規格 §11、FR-AGG-01～05）。
 *
 * `stats_snapshot` 是 **NOT NULL**：可為 null 等於允許存在一列無法重現的分析結果，
 * 而 FR-AGG-05 要的正是「結論可以回頭驗證」。所有結論都必須能對照當時的統計數字。
 */
export const aggregateAnalyses = pgTable(
  'aggregate_analyses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // ERD 未列，但少了它就無法追溯一份分析出自哪一次執行。
    aiJobId: uuid('ai_job_id').references(() => aiJobs.id, { onDelete: 'set null' }),

    scopeType: text('scope_type').notNull().default('all'),
    scopeRefIds: jsonb('scope_ref_ids').notNull().default(sql`'[]'::jsonb`),
    periodFrom: timestamp('period_from', { withTimezone: true }).notNull(),
    periodTo: timestamp('period_to', { withTimezone: true }).notNull(),

    /** 分析當下的統計數據，讓結論可重現（FR-AGG-05）。 */
    statsSnapshot: jsonb('stats_snapshot').notNull(),
    representativeQuestionIds: uuid('representative_question_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),

    weakestKnowledgeTags: jsonb('weakest_knowledge_tags'),
    commonErrorTypes: jsonb('common_error_types'),
    errorPatterns: jsonb('error_patterns'),
    reviewPriority: jsonb('review_priority'),
    recommendedGroups: jsonb('recommended_groups'),
    improvement: jsonb('improvement'),
    suggestions: jsonb('suggestions'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),

    promptVersion: text('prompt_version'),
    model: text('model').notNull(),
    analysisVersion: integer('analysis_version').notNull().default(1),
    rawOutput: jsonb('raw_output'),
    ...timestamps,
  },
  (t) => [
    check(
      'aggregate_analyses_scope_type_check',
      sql`${t.scopeType} in ('all', 'subject', 'chapter', 'question_group', 'knowledge_tag')`,
    ),
    check('aggregate_analyses_period_check', sql`${t.periodTo} > ${t.periodFrom}`),
    // 把純函式的上限鎖進資料庫，做法比照 mistake_records 的熟練狀態一致性約束。
    // 數字必須與 REPRESENTATIVE_QUESTION_LIMIT 一致。
    check(
      'aggregate_analyses_representative_limit_check',
      sql`cardinality(${t.representativeQuestionIds}) <= 15`,
    ),
    index('aggregate_analyses_user_created_idx').on(t.userId, t.createdAt.desc()),
  ],
);
