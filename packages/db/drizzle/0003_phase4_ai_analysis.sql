CREATE TABLE "ai_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"job_type" text NOT NULL,
	"queue" text NOT NULL,
	"bullmq_job_id" text,
	"idempotency_key" text NOT NULL,
	"question_id" uuid,
	"user_answer_id" uuid,
	"target_ref" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"progress_step" text DEFAULT 'QUEUED' NOT NULL,
	"progress_pct" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 2 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"served_from_cache" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ai_jobs_type_check" CHECK ("ai_jobs"."job_type" in ('question_analysis', 'aggregate_analysis', 'maintenance')),
	CONSTRAINT "ai_jobs_status_check" CHECK ("ai_jobs"."status" in ('pending', 'active', 'completed', 'failed', 'retrying', 'cancelled')),
	CONSTRAINT "ai_jobs_priority_check" CHECK ("ai_jobs"."priority" between 1 and 4),
	CONSTRAINT "ai_jobs_progress_check" CHECK ("ai_jobs"."progress_pct" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "ai_usage_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ai_job_id" uuid,
	"user_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text,
	"request_status" text NOT NULL,
	"http_status" integer,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"reasoning_effort" text,
	"finish_reason" text,
	"error_code" text,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"attempt_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_logs_status_check" CHECK ("ai_usage_logs"."request_status" in ('success', 'schema_invalid', 'semantic_invalid', 'rate_limited', 'http_error', 'timeout', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "answer_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"evidence_set_id" uuid,
	"ai_job_id" uuid,
	"stored_answers" text[] NOT NULL,
	"verified_answers" text[] NOT NULL,
	"confidence" numeric(4, 3),
	"conflict_reason" text NOT NULL,
	"evidence" jsonb,
	"source_ids" text[],
	"requires_review" boolean DEFAULT true NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_conflicts_review_status_check" CHECK ("answer_conflicts"."review_status" in ('pending', 'kept_original', 'answer_updated', 'explanation_updated', 'marked_disputed', 'question_excluded')),
	CONSTRAINT "answer_conflicts_reviewed_check" CHECK (("answer_conflicts"."review_status" = 'pending') = ("answer_conflicts"."reviewed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "personalized_mistake_analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"user_answer_id" uuid,
	"cache_key" text NOT NULL,
	"selected_answers" text[] NOT NULL,
	"correct_answers" text[] NOT NULL,
	"question_version" integer NOT NULL,
	"prompt_version" text,
	"model" text NOT NULL,
	"user_was_correct" boolean DEFAULT false NOT NULL,
	"why_wrong" text,
	"missed_conditions" jsonb,
	"error_type_id" uuid,
	"review_suggestions" jsonb,
	"citations" jsonb,
	"confidence" numeric(4, 3),
	"requires_human_review" boolean DEFAULT false NOT NULL,
	"raw_output" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personalized_mistake_analyses_cache_key_unique" UNIQUE("cache_key")
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation" text NOT NULL,
	"version" text NOT NULL,
	"system_prompt" text NOT NULL,
	"user_template" text NOT NULL,
	"output_schema" jsonb,
	"model_defaults" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_versions_operation_version_unique" UNIQUE("operation","version"),
	CONSTRAINT "prompt_versions_operation_check" CHECK ("prompt_versions"."operation" in ('research_plan', 'evidence_synthesis', 'final_explanation', 'aggregate_analysis'))
);
--> statement-breakpoint
CREATE TABLE "question_ai_enrichments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"question_content_hash" text NOT NULL,
	"evidence_set_id" uuid,
	"prompt_version_plan" text,
	"prompt_version_evidence" text,
	"prompt_version_final" text,
	"model" text NOT NULL,
	"research_mode" text NOT NULL,
	"canonical_explanation" text,
	"core_concept" text,
	"solution_steps" jsonb,
	"option_analysis" jsonb,
	"answer_validation" jsonb,
	"primary_knowledge_tag_id" uuid,
	"confidence" numeric(4, 3),
	"requires_human_review" boolean DEFAULT false NOT NULL,
	"raw_output" jsonb,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_evidence_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"ai_job_id" uuid,
	"research_mode" text NOT NULL,
	"plan" jsonb,
	"queries" jsonb,
	"evidence_summary" text,
	"supported_claims" jsonb,
	"contradicted_claims" jsonb,
	"conflicts" jsonb,
	"insufficient_evidence" boolean DEFAULT false NOT NULL,
	"recommended_answers" text[],
	"confidence" numeric(4, 3),
	"requires_human_review" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_evidence_sets_mode_check" CHECK ("question_evidence_sets"."research_mode" in ('MODEL_ONLY', 'PDF_KNOWLEDGE', 'WEB_RESEARCH', 'HYBRID'))
);
--> statement-breakpoint
CREATE TABLE "question_evidence_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_set_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"url" text NOT NULL,
	"domain" text NOT NULL,
	"title" text NOT NULL,
	"published_date" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_snippet" text,
	"content_length" integer,
	"search_provider" text,
	"search_query" text,
	"rank" integer,
	"score" numeric(6, 4),
	"trust_tier" text DEFAULT 'other' NOT NULL,
	"is_used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_evidence_sources_set_source_unique" UNIQUE("evidence_set_id","source_id"),
	CONSTRAINT "question_evidence_sources_trust_tier_check" CHECK ("question_evidence_sources"."trust_tier" in ('official', 'academic', 'educational', 'reference', 'other'))
);
--> statement-breakpoint
CREATE TABLE "web_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url_hash" text NOT NULL,
	"url" text NOT NULL,
	"domain" text NOT NULL,
	"title" text,
	"extracted_text" text,
	"content_length" integer,
	"http_status" integer,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_documents_url_hash_unique" UNIQUE("url_hash")
);
--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_user_answer_id_user_answers_id_fk" FOREIGN KEY ("user_answer_id") REFERENCES "public"."user_answers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_conflicts" ADD CONSTRAINT "answer_conflicts_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_conflicts" ADD CONSTRAINT "answer_conflicts_evidence_set_id_question_evidence_sets_id_fk" FOREIGN KEY ("evidence_set_id") REFERENCES "public"."question_evidence_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_conflicts" ADD CONSTRAINT "answer_conflicts_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_conflicts" ADD CONSTRAINT "answer_conflicts_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personalized_mistake_analyses" ADD CONSTRAINT "personalized_mistake_analyses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personalized_mistake_analyses" ADD CONSTRAINT "personalized_mistake_analyses_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personalized_mistake_analyses" ADD CONSTRAINT "personalized_mistake_analyses_user_answer_id_user_answers_id_fk" FOREIGN KEY ("user_answer_id") REFERENCES "public"."user_answers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personalized_mistake_analyses" ADD CONSTRAINT "personalized_mistake_analyses_error_type_id_error_types_id_fk" FOREIGN KEY ("error_type_id") REFERENCES "public"."error_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_ai_enrichments" ADD CONSTRAINT "question_ai_enrichments_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_ai_enrichments" ADD CONSTRAINT "question_ai_enrichments_evidence_set_id_question_evidence_sets_id_fk" FOREIGN KEY ("evidence_set_id") REFERENCES "public"."question_evidence_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_ai_enrichments" ADD CONSTRAINT "question_ai_enrichments_primary_knowledge_tag_id_knowledge_tags_id_fk" FOREIGN KEY ("primary_knowledge_tag_id") REFERENCES "public"."knowledge_tags"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_evidence_sets" ADD CONSTRAINT "question_evidence_sets_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_evidence_sets" ADD CONSTRAINT "question_evidence_sets_ai_job_id_ai_jobs_id_fk" FOREIGN KEY ("ai_job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_evidence_sources" ADD CONSTRAINT "question_evidence_sources_evidence_set_id_question_evidence_sets_id_fk" FOREIGN KEY ("evidence_set_id") REFERENCES "public"."question_evidence_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_jobs_user_status_idx" ON "ai_jobs" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "ai_jobs_created_idx" ON "ai_jobs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_jobs_question_idx" ON "ai_jobs" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "ai_usage_logs_created_idx" ON "ai_usage_logs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_usage_logs_operation_status_idx" ON "ai_usage_logs" USING btree ("operation","request_status");--> statement-breakpoint
CREATE INDEX "ai_usage_logs_user_idx" ON "ai_usage_logs" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "answer_conflicts_pending_unique" ON "answer_conflicts" USING btree ("question_id") WHERE review_status = 'pending';--> statement-breakpoint
CREATE INDEX "answer_conflicts_status_idx" ON "answer_conflicts" USING btree ("review_status");--> statement-breakpoint
CREATE INDEX "personalized_mistake_analyses_user_question_idx" ON "personalized_mistake_analyses" USING btree ("user_id","question_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_active_unique" ON "prompt_versions" USING btree ("operation") WHERE is_active = true;--> statement-breakpoint
CREATE UNIQUE INDEX "question_ai_enrichments_current_unique" ON "question_ai_enrichments" USING btree ("question_id") WHERE is_current = true;--> statement-breakpoint
CREATE INDEX "question_ai_enrichments_question_idx" ON "question_ai_enrichments" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "question_ai_enrichments_hash_idx" ON "question_ai_enrichments" USING btree ("question_content_hash");--> statement-breakpoint
CREATE INDEX "question_evidence_sets_question_idx" ON "question_evidence_sets" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "question_evidence_sources_set_idx" ON "question_evidence_sources" USING btree ("evidence_set_id");--> statement-breakpoint
CREATE INDEX "web_documents_expires_idx" ON "web_documents" USING btree ("expires_at");