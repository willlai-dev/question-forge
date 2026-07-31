CREATE TABLE "error_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_fallback" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "error_types_code_unique" UNIQUE("code"),
	CONSTRAINT "error_types_status_check" CHECK ("error_types"."status" in ('active', 'deprecated', 'merged'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subject_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"parent_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_tags_status_check" CHECK ("knowledge_tags"."status" in ('active', 'deprecated', 'merged')),
	CONSTRAINT "knowledge_tags_merged_target_check" CHECK (("knowledge_tags"."status" = 'merged') = ("knowledge_tags"."merged_into_id" is not null)),
	CONSTRAINT "knowledge_tags_no_self_merge_check" CHECK ("knowledge_tags"."merged_into_id" is null or "knowledge_tags"."merged_into_id" <> "knowledge_tags"."id"),
	CONSTRAINT "knowledge_tags_no_self_parent_check" CHECK ("knowledge_tags"."parent_id" is null or "knowledge_tags"."parent_id" <> "knowledge_tags"."id")
);
--> statement-breakpoint
CREATE TABLE "question_knowledge_tags" (
	"question_id" uuid NOT NULL,
	"knowledge_tag_id" uuid NOT NULL,
	"role" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"confidence" numeric(4, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_knowledge_tags_question_id_knowledge_tag_id_pk" PRIMARY KEY("question_id","knowledge_tag_id"),
	CONSTRAINT "question_knowledge_tags_role_check" CHECK ("question_knowledge_tags"."role" in ('primary', 'secondary')),
	CONSTRAINT "question_knowledge_tags_source_check" CHECK ("question_knowledge_tags"."source" in ('manual', 'ai', 'import'))
);
--> statement-breakpoint
CREATE TABLE "question_skill_tags" (
	"question_id" uuid NOT NULL,
	"skill_tag_id" uuid NOT NULL,
	"role" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"confidence" numeric(4, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_skill_tags_question_id_skill_tag_id_pk" PRIMARY KEY("question_id","skill_tag_id"),
	CONSTRAINT "question_skill_tags_role_check" CHECK ("question_skill_tags"."role" in ('primary', 'secondary')),
	CONSTRAINT "question_skill_tags_source_check" CHECK ("question_skill_tags"."source" in ('manual', 'ai', 'import'))
);
--> statement-breakpoint
CREATE TABLE "skill_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_tags_slug_unique" UNIQUE("slug"),
	CONSTRAINT "skill_tags_status_check" CHECK ("skill_tags"."status" in ('active', 'deprecated', 'merged'))
);
--> statement-breakpoint
CREATE TABLE "tag_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tag_kind" text NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"canonical_tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_aliases_kind_normalized_unique" UNIQUE("user_id","tag_kind","normalized_alias"),
	CONSTRAINT "tag_aliases_kind_check" CHECK ("tag_aliases"."tag_kind" in ('knowledge', 'skill', 'error_type'))
);
--> statement-breakpoint
CREATE TABLE "tag_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tag_kind" text NOT NULL,
	"suggested_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"context_question_id" uuid,
	"source" text DEFAULT 'user' NOT NULL,
	"rationale" text,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolved_tag_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_suggestions_kind_check" CHECK ("tag_suggestions"."tag_kind" in ('knowledge', 'skill', 'error_type')),
	CONSTRAINT "tag_suggestions_source_check" CHECK ("tag_suggestions"."source" in ('ai', 'user')),
	CONSTRAINT "tag_suggestions_status_check" CHECK ("tag_suggestions"."status" in ('pending', 'approved', 'merged', 'rejected')),
	CONSTRAINT "tag_suggestions_reviewed_check" CHECK (("tag_suggestions"."status" = 'pending') = ("tag_suggestions"."reviewed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "mistake_record_error_types" (
	"mistake_record_id" uuid NOT NULL,
	"error_type_id" uuid NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mistake_record_error_types_mistake_record_id_error_type_id_pk" PRIMARY KEY("mistake_record_id","error_type_id"),
	CONSTRAINT "mistake_record_error_types_source_check" CHECK ("mistake_record_error_types"."source" in ('manual', 'ai'))
);
--> statement-breakpoint
ALTER TABLE "mistake_records" ADD COLUMN "last_error_type_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_tags" ADD CONSTRAINT "knowledge_tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_tags" ADD CONSTRAINT "knowledge_tags_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_tags" ADD CONSTRAINT "knowledge_tags_parent_id_knowledge_tags_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."knowledge_tags"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_tags" ADD CONSTRAINT "knowledge_tags_merged_into_id_knowledge_tags_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."knowledge_tags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_knowledge_tags" ADD CONSTRAINT "question_knowledge_tags_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_knowledge_tags" ADD CONSTRAINT "question_knowledge_tags_knowledge_tag_id_knowledge_tags_id_fk" FOREIGN KEY ("knowledge_tag_id") REFERENCES "public"."knowledge_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_skill_tags" ADD CONSTRAINT "question_skill_tags_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_skill_tags" ADD CONSTRAINT "question_skill_tags_skill_tag_id_skill_tags_id_fk" FOREIGN KEY ("skill_tag_id") REFERENCES "public"."skill_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_aliases" ADD CONSTRAINT "tag_aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_suggestions" ADD CONSTRAINT "tag_suggestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_suggestions" ADD CONSTRAINT "tag_suggestions_context_question_id_questions_id_fk" FOREIGN KEY ("context_question_id") REFERENCES "public"."questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mistake_record_error_types" ADD CONSTRAINT "mistake_record_error_types_mistake_record_id_mistake_records_id_fk" FOREIGN KEY ("mistake_record_id") REFERENCES "public"."mistake_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mistake_record_error_types" ADD CONSTRAINT "mistake_record_error_types_error_type_id_error_types_id_fk" FOREIGN KEY ("error_type_id") REFERENCES "public"."error_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "error_types_single_fallback_unique" ON "error_types" USING btree ("is_fallback") WHERE is_fallback = true;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_tags_scope_slug_unique" ON "knowledge_tags" USING btree ("user_id","subject_id","slug") WHERE status <> 'merged' and subject_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_tags_global_slug_unique" ON "knowledge_tags" USING btree ("user_id","slug") WHERE status <> 'merged' and subject_id is null;--> statement-breakpoint
CREATE INDEX "knowledge_tags_user_status_idx" ON "knowledge_tags" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_tags_parent_idx" ON "knowledge_tags" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "question_knowledge_tags_primary_unique" ON "question_knowledge_tags" USING btree ("question_id") WHERE role = 'primary';--> statement-breakpoint
CREATE INDEX "question_knowledge_tags_tag_idx" ON "question_knowledge_tags" USING btree ("knowledge_tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "question_skill_tags_primary_unique" ON "question_skill_tags" USING btree ("question_id") WHERE role = 'primary';--> statement-breakpoint
CREATE INDEX "question_skill_tags_tag_idx" ON "question_skill_tags" USING btree ("skill_tag_id");--> statement-breakpoint
CREATE INDEX "tag_aliases_canonical_idx" ON "tag_aliases" USING btree ("canonical_tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_suggestions_pending_unique" ON "tag_suggestions" USING btree ("user_id","tag_kind","normalized_name") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "tag_suggestions_status_idx" ON "tag_suggestions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "mistake_record_error_types_error_idx" ON "mistake_record_error_types" USING btree ("error_type_id");--> statement-breakpoint
ALTER TABLE "mistake_records" ADD CONSTRAINT "mistake_records_last_error_type_id_error_types_id_fk" FOREIGN KEY ("last_error_type_id") REFERENCES "public"."error_types"("id") ON DELETE set null ON UPDATE no action;