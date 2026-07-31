CREATE TYPE "public"."reveal_mode" AS ENUM('immediate', 'after_submit');--> statement-breakpoint
CREATE TABLE "mistake_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"mistake_count" integer DEFAULT 0 NOT NULL,
	"consecutive_correct" integer DEFAULT 0 NOT NULL,
	"total_attempts" integer DEFAULT 0 NOT NULL,
	"recent_accuracy" numeric(5, 4),
	"mastery_state" text DEFAULT 'active' NOT NULL,
	"first_missed_at" timestamp with time zone,
	"last_missed_at" timestamp with time zone,
	"last_answered_at" timestamp with time zone,
	"is_resolved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mistake_records_mastery_state_check" CHECK ("mistake_records"."mastery_state" in ('active', 'improving', 'mastered')),
	CONSTRAINT "mistake_records_mastery_consistency_check" CHECK ("mistake_records"."mastery_state" = case
            when "mistake_records"."consecutive_correct" <= 0 then 'active'
            when "mistake_records"."consecutive_correct" < 3 then 'improving'
            else 'mastered'
          end)
);
--> statement-breakpoint
CREATE TABLE "quiz_session_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"option_order" text[] NOT NULL,
	"question_version" integer NOT NULL,
	"correct_answers_snapshot" text[] NOT NULL,
	"status" text DEFAULT 'unanswered' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_session_questions_position_unique" UNIQUE("session_id","position"),
	CONSTRAINT "quiz_session_questions_question_unique" UNIQUE("session_id","question_id"),
	CONSTRAINT "quiz_session_questions_status_check" CHECK ("quiz_session_questions"."status" in ('unanswered', 'answered', 'skipped')),
	CONSTRAINT "quiz_session_questions_position_check" CHECK ("quiz_session_questions"."position" > 0)
);
--> statement-breakpoint
CREATE TABLE "quiz_session_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"ref_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_session_scopes_unique" UNIQUE("session_id","scope_type","ref_id"),
	CONSTRAINT "quiz_session_scopes_type_check" CHECK ("quiz_session_scopes"."scope_type" in ('subject', 'chapter', 'question_group', 'knowledge_tag', 'mistake'))
);
--> statement-breakpoint
CREATE TABLE "quiz_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"mode" text DEFAULT 'practice' NOT NULL,
	"order_strategy" text DEFAULT 'sequential' NOT NULL,
	"shuffle_options" boolean DEFAULT false NOT NULL,
	"question_limit" integer,
	"reveal_mode" "reveal_mode" DEFAULT 'immediate' NOT NULL,
	"allow_answer_change" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"seed" integer NOT NULL,
	"total_questions" integer DEFAULT 0 NOT NULL,
	"answered_count" integer DEFAULT 0 NOT NULL,
	"correct_count" integer DEFAULT 0 NOT NULL,
	"score" numeric(5, 2),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"duration_ms" integer,
	"config_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_sessions_mode_check" CHECK ("quiz_sessions"."mode" in ('practice', 'mistake_review', 'knowledge_focus', 'exam')),
	CONSTRAINT "quiz_sessions_order_strategy_check" CHECK ("quiz_sessions"."order_strategy" in ('sequential', 'random')),
	CONSTRAINT "quiz_sessions_status_check" CHECK ("quiz_sessions"."status" in ('in_progress', 'submitted', 'abandoned')),
	CONSTRAINT "quiz_sessions_question_limit_check" CHECK ("quiz_sessions"."question_limit" is null or "quiz_sessions"."question_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "user_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"session_question_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"selected_answers" text[] NOT NULL,
	"correct_answers_snapshot" text[] NOT NULL,
	"is_correct" boolean NOT NULL,
	"is_provisional" boolean DEFAULT false NOT NULL,
	"response_time_ms" integer,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"answer_changed_count" integer DEFAULT 0 NOT NULL,
	"reveal_mode" "reveal_mode" NOT NULL,
	"question_version" integer NOT NULL,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_answers_attempt_unique" UNIQUE("session_question_id","attempt_number")
);
--> statement-breakpoint
ALTER TABLE "mistake_records" ADD CONSTRAINT "mistake_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mistake_records" ADD CONSTRAINT "mistake_records_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_session_questions" ADD CONSTRAINT "quiz_session_questions_session_id_quiz_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."quiz_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_session_questions" ADD CONSTRAINT "quiz_session_questions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_session_scopes" ADD CONSTRAINT "quiz_session_scopes_session_id_quiz_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."quiz_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_sessions" ADD CONSTRAINT "quiz_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_answers" ADD CONSTRAINT "user_answers_session_id_quiz_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."quiz_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_answers" ADD CONSTRAINT "user_answers_session_question_id_quiz_session_questions_id_fk" FOREIGN KEY ("session_question_id") REFERENCES "public"."quiz_session_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_answers" ADD CONSTRAINT "user_answers_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_answers" ADD CONSTRAINT "user_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mistake_records_user_question_unique" ON "mistake_records" USING btree ("user_id","question_id");--> statement-breakpoint
CREATE INDEX "mistake_records_user_state_idx" ON "mistake_records" USING btree ("user_id","mastery_state");--> statement-breakpoint
CREATE INDEX "mistake_records_user_last_missed_idx" ON "mistake_records" USING btree ("user_id","last_missed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "quiz_session_questions_question_idx" ON "quiz_session_questions" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "quiz_session_scopes_ref_idx" ON "quiz_session_scopes" USING btree ("scope_type","ref_id");--> statement-breakpoint
CREATE INDEX "quiz_sessions_user_started_idx" ON "quiz_sessions" USING btree ("user_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "quiz_sessions_user_status_idx" ON "quiz_sessions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "user_answers_user_question_idx" ON "user_answers" USING btree ("user_id","question_id","answered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_answers_session_idx" ON "user_answers" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "user_answers_diagnostic_idx" ON "user_answers" USING btree ("user_id","is_correct") WHERE is_provisional = false;