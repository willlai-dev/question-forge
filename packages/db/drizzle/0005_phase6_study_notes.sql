-- 章節筆記：單章 PDF 匯入時一併帶入，成為該題庫的本地資料源。
--
-- 設計決定：
--
-- 1. 筆記與網頁走**同一張** question_evidence_sources。
--    因此「citations ⊆ 本次來源」與「quote 必須逐字出自來源」對筆記
--    一體適用，不必為新來源種類複製一套驗證——複製遲早會分岔，
--    而這裡分岔的後果是 AI 可以捏造筆記內容。
--
-- 2. url / domain 由 NOT NULL 放寬為可空，改以 CHECK 依 source_type 強制：
--    放寬是為了容納沒有 URL 的筆記，不是為了讓網頁來源可以沒有出處。
--
-- 3. study_note_id 刻意**不加外鍵**。
--    question_evidence_sources 是「當次分析看到什麼」的快照，
--    content_snippet 自帶正文，本來就不依賴來源表是否還在——
--    既有的 web_documents 也沒有外鍵指過來，這裡保持一致。
--    筆記被刪除後，舊分析仍要能解釋當時依據的是什麼。
--
-- 4. question_ai_enrichments.notes_fingerprint 是快取判準的新成員。
--    question_content_hash 只涵蓋題目本身：筆記重新匯入後題目沒變、
--    雜湊不變，舊解析會繼續命中快取，使用者改了筆記卻看不到差別。
--    既有列為 null，視同「當時沒有筆記」。
--
-- 5. 不回填。既有分析產生時沒有筆記可用，事後補上關聯會讓
--    「這份解析當初依據了什麼」變成假的。舊分析維持原樣，
--    重新分析才會帶入筆記。

CREATE TABLE "question_note_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"study_note_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "study_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"chapter_id" uuid,
	"question_group_id" uuid NOT NULL,
	"import_batch_id" uuid,
	"note_key" text NOT NULL,
	"title" text,
	"content" text NOT NULL,
	"source_page" integer,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"content_hash" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "study_notes_content_check" CHECK (length("study_notes"."content") > 0)
);
--> statement-breakpoint
ALTER TABLE "question_evidence_sources" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "question_evidence_sources" ALTER COLUMN "domain" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "note_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "question_ai_enrichments" ADD COLUMN "notes_fingerprint" text;--> statement-breakpoint
ALTER TABLE "question_evidence_sources" ADD COLUMN "source_type" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_evidence_sources" ADD COLUMN "study_note_id" uuid;--> statement-breakpoint
ALTER TABLE "question_note_links" ADD CONSTRAINT "question_note_links_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_note_links" ADD CONSTRAINT "question_note_links_study_note_id_study_notes_id_fk" FOREIGN KEY ("study_note_id") REFERENCES "public"."study_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_notes" ADD CONSTRAINT "study_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_notes" ADD CONSTRAINT "study_notes_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_notes" ADD CONSTRAINT "study_notes_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_notes" ADD CONSTRAINT "study_notes_question_group_id_question_groups_id_fk" FOREIGN KEY ("question_group_id") REFERENCES "public"."question_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_notes" ADD CONSTRAINT "study_notes_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "question_note_links_unique" ON "question_note_links" USING btree ("question_id","study_note_id");--> statement-breakpoint
CREATE INDEX "question_note_links_question_idx" ON "question_note_links" USING btree ("question_id");--> statement-breakpoint
CREATE UNIQUE INDEX "study_notes_group_key_unique" ON "study_notes" USING btree ("question_group_id","note_key") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "study_notes_group_idx" ON "study_notes" USING btree ("question_group_id");--> statement-breakpoint
CREATE INDEX "study_notes_subject_idx" ON "study_notes" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "study_notes_chapter_idx" ON "study_notes" USING btree ("chapter_id");--> statement-breakpoint
ALTER TABLE "question_evidence_sources" ADD CONSTRAINT "question_evidence_sources_source_type_check" CHECK ("question_evidence_sources"."source_type" in ('web', 'note'));--> statement-breakpoint
ALTER TABLE "question_evidence_sources" ADD CONSTRAINT "question_evidence_sources_web_url_check" CHECK ("question_evidence_sources"."source_type" <> 'web' or ("question_evidence_sources"."url" is not null and "question_evidence_sources"."domain" is not null));--> statement-breakpoint
ALTER TABLE "question_evidence_sources" ADD CONSTRAINT "question_evidence_sources_note_ref_check" CHECK ("question_evidence_sources"."source_type" <> 'note' or "question_evidence_sources"."study_note_id" is not null);
