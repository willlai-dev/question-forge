-- Phase 5：多題整合分析。
--
-- mistake_record_error_types.occurrence_count 從本次 migration 起才會真正遞增
-- （只由 AI 分析路徑遞增；手動標記是取代語意，重複儲存不算又錯一次）。
-- 既有資料一律停在 1，**刻意不做回填**：手動標記沒有留下指派歷史、真實次數無法還原，
-- 而只回填 AI 來源會讓兩種來源的數字失去可比性。因此 migration 之前的資料是
-- 一致的低估，之後才準確；讀這張表的人請留意這條分界。
CREATE TABLE "aggregate_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ai_job_id" uuid,
	"scope_type" text DEFAULT 'all' NOT NULL,
	"scope_ref_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"period_from" timestamp with time zone NOT NULL,
	"period_to" timestamp with time zone NOT NULL,
	"stats_snapshot" jsonb NOT NULL,
	"representative_question_ids" uuid[] DEFAULT '{}' NOT NULL,
	"weakest_knowledge_tags" jsonb,
	"common_error_types" jsonb,
	"error_patterns" jsonb,
	"review_priority" jsonb,
	"recommended_groups" jsonb,
	"improvement" jsonb,
	"suggestions" jsonb,
	"confidence" numeric(4, 3),
	"prompt_version" text,
	"model" text NOT NULL,
	"analysis_version" integer DEFAULT 1 NOT NULL,
	"raw_output" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aggregate_analyses_scope_type_check" CHECK ("aggregate_analyses"."scope_type" in ('all', 'subject', 'chapter', 'question_group', 'knowledge_tag')),
	CONSTRAINT "aggregate_analyses_period_check" CHECK ("aggregate_analyses"."period_to" > "aggregate_analyses"."period_from"),
	CONSTRAINT "aggregate_analyses_representative_limit_check" CHECK (cardinality("aggregate_analyses"."representative_question_ids") <= 15)
);
--> statement-breakpoint
ALTER TABLE "aggregate_analyses" ADD CONSTRAINT "aggregate_analyses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aggregate_analyses" ADD CONSTRAINT "aggregate_analyses_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aggregate_analyses_user_created_idx" ON "aggregate_analyses" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_answers_diagnostic_period_idx" ON "user_answers" USING btree ("user_id","answered_at") WHERE is_provisional = false;--> statement-breakpoint
ALTER TABLE "mistake_record_error_types" ADD CONSTRAINT "mistake_record_error_types_occurrence_check" CHECK ("mistake_record_error_types"."occurrence_count" > 0);