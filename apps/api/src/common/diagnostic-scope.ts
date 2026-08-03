/**
 * 「什麼資料可以拿來做能力診斷」——全系統唯一的判準。
 *
 * 刻意寫成純模組而不是 Nest provider：這裡沒有狀態也沒有依賴，
 * 用 DI 只會逼三個模組多寫 imports。同樣的做法見 `modules/question-bank/counts.ts`。
 *
 * 為什麼必須共用一份：
 * 這些條件原本只存在於 `MistakesService` 的私有方法裡，而 `StatsService.overview()`
 * 完全沒套用，於是儀表板的錯題總數與錯題頁的錯題總數對不起來——同一個使用者、
 * 同一份資料，兩個畫面給出不同答案。多題分析若再各寫一份，只會讓不一致擴散。
 */

import { schema } from '@repo/db';
import { and, eq, gte, inArray, isNull, lt, notInArray, sql, type SQL } from 'drizzle-orm';

/** 統計期間。半開區間 `[from, to)`。 */
export interface DiagnosticPeriod {
  from: Date;
  to: Date;
}

/**
 * 這一題可以拿來做能力診斷嗎。
 *
 * 呼叫端的 FROM/JOIN 鏈中必須有 `questions`，否則 SQL 會找不到欄位。
 *
 * - 軟刪除的題目：錯題紀錄保留，但不再列出，也不計入統計。
 * - `disputed`：答案還在爭議待審，計入診斷等於用一個可能錯誤的答案評斷使用者（驗收 #18）。
 * - `excluded`：人工裁決認定這題不該用。
 */
export function diagnosableQuestion(): SQL {
  return and(
    isNull(schema.questions.deletedAt),
    notInArray(schema.questions.status, ['disputed', 'excluded']),
  )!;
}

/**
 * 這一次作答算數嗎：本人的、且不是暫記（FR-QUIZ-14）。
 *
 * 爭議待審期間該題的作答一律標為 `is_provisional`，裁決後才恢復；
 * 若裁決是「排除該題」或「維持爭議」，就永遠不恢復。
 */
export function countableAnswer(userId: string): SQL {
  return and(
    eq(schema.userAnswers.userId, userId),
    eq(schema.userAnswers.isProvisional, false),
  )!;
}

/**
 * 診斷用作答的完整條件。必須與 `innerJoin(questions)` 併用。
 *
 * `period` 省略即不限時間。時間用半開區間 `[from, to)`：
 * 相鄰兩期不會重複計算同一筆作答，也沒有 `23:59:59.999` 的邊界問題。
 */
export function diagnosticScope(
  userId: string,
  period?: DiagnosticPeriod,
  target?: DiagnosticTarget,
): SQL {
  const conditions: SQL[] = [countableAnswer(userId), diagnosableQuestion()];
  if (period) {
    conditions.push(gte(schema.userAnswers.answeredAt, period.from));
    conditions.push(lt(schema.userAnswers.answeredAt, period.to));
  }
  const narrowed = targetFilter(target);
  if (narrowed) conditions.push(narrowed);
  return and(...conditions)!;
}

/** 多題分析的範圍限定。`all` 代表整個題庫。 */
export interface DiagnosticTarget {
  scopeType: 'all' | 'subject' | 'chapter' | 'question_group' | 'knowledge_tag';
  scopeRefIds: readonly string[];
}

/**
 * 把分析範圍轉成查詢條件。必須與 `innerJoin(questions)` 併用。
 *
 * `all`（或沒指定 ID）回 undefined，呼叫端就不會加任何限制。
 *
 * 知識點是唯一需要子查詢的維度：題目與知識點是多對多，直接 join 會讓
 * 同一筆作答被放大成多列而污染總數。用 EXISTS 只做存在性判斷，不改變列數。
 *
 * 子查詢裡的欄位一律寫死資料表名稱，不用 `${schema.x.y}` 內插——
 * drizzle 會把它算繪成未限定的欄位名，在子查詢中會被解析成子查詢自己那張表的欄位。
 */
export function targetFilter(target?: DiagnosticTarget): SQL | undefined {
  if (!target || target.scopeType === 'all') return undefined;
  const ids = [...target.scopeRefIds];
  if (ids.length === 0) return undefined;

  switch (target.scopeType) {
    case 'subject':
      return inArray(schema.questions.subjectId, ids);
    case 'chapter':
      return inArray(schema.questions.chapterId, ids);
    case 'question_group':
      return inArray(schema.questions.questionGroupId, ids);
    case 'knowledge_tag':
      return sql`exists (
        select 1 from question_knowledge_tags qkt
        where qkt.question_id = questions.id
          and qkt.knowledge_tag_id in ${ids}
      )`;
  }
}

/** 錯題紀錄版本的範圍限定（錯誤類型統計走 mistake_records，不經 user_answers）。 */
export function diagnosticMistakeTarget(target?: DiagnosticTarget): SQL | undefined {
  return targetFilter(target);
}

/**
 * 排除「還在未交卷的交卷後對答案場次裡」的錯題。
 *
 * `after_submit` 模式的作答端點不回傳正確答案，但錯題紀錄在答錯當下就建立了，
 * 於是交卷前就能從錯題本讀到正確答案與本次對錯，繞過整個機制（驗收 #7）。
 *
 * 連「出現在列表裡」「被計入錯題總數」都要擋——在還沒對答案的情況下，
 * 一題出現在錯題本、或錯題數多了一題，本身就等於告訴你那題答錯了。
 * 交卷後就會正常出現。
 *
 * 相關子查詢一律寫死資料表名稱來限定欄位，不用 `${schema.x.y}` 內插：
 * drizzle 會把它算繪成未限定的欄位名，在子查詢中會被解析成子查詢自己那張表的欄位。
 */
export function notInUnsubmittedExam(userId: string): SQL {
  return sql`not exists (
    select 1 from user_answers ua
    join quiz_sessions qs on qs.id = ua.session_id
    where ua.question_id = mistake_records.question_id
      and ua.user_id = ${userId}
      and qs.status = 'in_progress'
      and qs.reveal_mode = 'after_submit'
  )`;
}

/** 錯題紀錄的診斷條件。必須與 `innerJoin(questions)` 併用。 */
export function diagnosticMistakeScope(userId: string): SQL {
  return and(
    eq(schema.mistakeRecords.userId, userId),
    diagnosableQuestion(),
    notInUnsubmittedExam(userId),
  )!;
}
