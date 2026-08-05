-- 一個匯入批次可以帶多個題組（同一科目的不同章節）。
--
-- 輸入有兩種形式：單一檔案內的 questionGroups 陣列（格式 1.2.0），
-- 或一次上傳多個舊格式檔案。兩者都在驗證階段正規化成 import_question_groups，
-- 因此後續流程只有一條路徑——這是刻意的，兩條路徑遲早會分岔。
--
-- import_questions.import_group_id 可為空，只是為了相容這個欄位出現之前的
-- 舊批次。本專案的既有批次全部已是 committed / discarded 終端狀態，
-- 因此不做資料回填；新批次一律有值，commit 也只走有值的路徑。

CREATE TABLE "import_question_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"group_index" integer NOT NULL,
	"source_filename" text,
	"chapter_name" text,
	"group_name" text NOT NULL,
	"source" text,
	"year" integer,
	"notes" text,
	"note_count" integer DEFAULT 0 NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"valid_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"committed_count" integer DEFAULT 0 NOT NULL,
	"resulting_group_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_question_groups_batch_index_unique" UNIQUE("batch_id","group_index")
);
--> statement-breakpoint
ALTER TABLE "import_questions" ADD COLUMN "import_group_id" uuid;--> statement-breakpoint
ALTER TABLE "import_question_groups" ADD CONSTRAINT "import_question_groups_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_question_groups" ADD CONSTRAINT "import_question_groups_resulting_group_id_question_groups_id_fk" FOREIGN KEY ("resulting_group_id") REFERENCES "public"."question_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_question_groups_batch_idx" ON "import_question_groups" USING btree ("batch_id");--> statement-breakpoint
ALTER TABLE "import_questions" ADD CONSTRAINT "import_questions_import_group_id_import_question_groups_id_fk" FOREIGN KEY ("import_group_id") REFERENCES "public"."import_question_groups"("id") ON DELETE cascade ON UPDATE no action;