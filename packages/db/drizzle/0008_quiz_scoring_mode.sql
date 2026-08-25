-- 交卷計分方式。
--
-- 分數的分母改為可選：
--   all_questions ——總題數，未作答視同答錯（模擬考的算法，也是舊有行為）
--   answered_only ——只算實際作答的題數，時間不夠而提早交卷時用
--
-- 順序很重要：必須先把既有已交卷場次補成 'all_questions'，才能加上
-- 一致性約束。否則任何一筆「有分數但沒有計分方式」的舊資料都會讓
-- migration 直接失敗，而那正是所有既有已交卷場次的狀態。
ALTER TABLE "quiz_sessions" ADD COLUMN "scoring_mode" text;--> statement-breakpoint

-- 既有場次一律標記為舊有行為，不改動任何已存在的分數。
UPDATE "quiz_sessions" SET "scoring_mode" = 'all_questions' WHERE "score" is not null;--> statement-breakpoint

ALTER TABLE "quiz_sessions" ADD CONSTRAINT "quiz_sessions_scoring_mode_check" CHECK ("quiz_sessions"."scoring_mode" is null or "quiz_sessions"."scoring_mode" in ('all_questions', 'answered_only'));--> statement-breakpoint
-- 交卷才有分數，有分數就一定要說得出分母。
ALTER TABLE "quiz_sessions" ADD CONSTRAINT "quiz_sessions_scoring_mode_consistency_check" CHECK (("quiz_sessions"."score" is null) = ("quiz_sessions"."scoring_mode" is null));
