/**
 * Drizzle schema 匯總點。
 *
 * Phase 0 刻意保持為空：本階段只交付 ERD 設計文件（docs/ERD.md），
 * 實際的 table 定義與 migration 屬於 Phase 1 起的工作，
 * 以符合 prompt.md §20.11「規劃完整後再開始實作」與 §20.20「不得在沒有 migration 的情況下修改資料庫結構」。
 *
 * Phase 1 起會依 docs/ERD.md 依序加入：
 *   ./identity      users / refresh_tokens / app_settings
 *   ./question-bank subjects / chapters / question_groups / questions / question_options / ...
 *   ./import        import_batches / import_questions / import_validation_issues
 *   ./tags          knowledge_tags / skill_tags / error_types / ...
 *   ./quiz          quiz_sessions / quiz_session_questions / user_answers / mistake_records
 *   ./ai            ai_jobs / ai_usage_logs / question_ai_enrichments / ...
 */

export {};
