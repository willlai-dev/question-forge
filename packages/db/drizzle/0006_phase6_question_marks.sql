-- 單題的個人標記與註記。
--
-- 在此之前，一道題目唯一會被「標出來」的方式是答錯（mistake_records）。
-- 但看到重要的題目時未必答錯，那些題目原本沒有任何地方可以留下痕跡。
--
-- 設計決定：
--
-- 1. 不重用 questions.review_required。那個欄位講的是「這道題目本身需要
--    人工複核」（匯入時答案存疑、OCR 可疑），屬於題庫品質。混進
--    「我覺得這題重要」會讓兩種語意再也分不開，篩選時也講不清楚在篩什麼。
--
-- 2. 不放進 questions 資料表。那裡是題目內容，有版本快照與內容雜湊；
--    個人標記是使用者狀態，跟著人走而不是跟著題目版本走。
--    放進去也會讓「標記一下」平白產生一個新的題目版本。
--
-- 3. is_flagged 與 note 各自獨立：可以只標記不寫字，也可以只寫註記不標記。
--    兩者都清空時由服務層刪除整列——「沒有標記」是乾淨的不存在，
--    而不是一列全是預設值的殘骸。

CREATE TABLE "question_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"is_flagged" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "question_marks" ADD CONSTRAINT "question_marks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_marks" ADD CONSTRAINT "question_marks_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "question_marks_user_question_unique" ON "question_marks" USING btree ("user_id","question_id");--> statement-breakpoint
CREATE INDEX "question_marks_flagged_idx" ON "question_marks" USING btree ("user_id","updated_at" DESC NULLS LAST) WHERE is_flagged = true;