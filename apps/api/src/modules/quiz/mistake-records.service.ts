import { Injectable } from '@nestjs/common';
import { applyAttempt, computeRecentAccuracy, type MistakeProgress } from '@repo/contracts';
import { schema, type Database } from '@repo/db';
import { and, asc, eq } from 'drizzle-orm';

/** 計算 recentAccuracy 時取的作答筆數。 */
const RECENT_WINDOW = 10;

/**
 * 錯題紀錄的維護。
 *
 * 關鍵設計：**錯題紀錄是 `user_answers` 的衍生狀態，不是獨立累加的計數器。**
 * 每次寫入作答後，就把該題所有作答重新摺疊（fold）一次算出結果。
 *
 * 為什麼不用「答錯就 +1」的增量寫法：
 *   - 使用者可以修改答案（FR-QUIZ-08）。增量寫法必須在改答案時反向扣回上一次的效果，
 *     而 mistakeCount／consecutiveCorrect／masteryState 的反向運算並不唯一，很容易算錯。
 *   - 重算是冪等的：同一份作答歷史重算幾次都得到同一個結果，不會因為重試或並行而漂移。
 *   - Phase 4 的爭議題排除（`is_provisional`）只要加在這裡的查詢條件，統計自然就跟著正確。
 *
 * 代價是每次作答多一次查詢。單一使用者、單題作答次數以十為單位，可以忽略。
 */
@Injectable()
export class MistakeRecordsService {
  /**
   * 依作答歷史重算某一題的錯題紀錄。
   *
   * 從未答錯過的題目不會產生紀錄。**答對之後也不會刪除既有紀錄**（FR-MIS-05）——
   * 那種情況下歷史裡仍有一次答錯，狀態機會保留 mistakeCount 並改以
   * masteryState／isResolved 表示已掌握，紀錄本身留著讓你還能回去複習。
   *
   * 唯一會刪掉紀錄的情況是「計入診斷的作答裡，已經一次錯誤都沒有」，
   * 也就是 progress 折疊完仍為 null。這不是「後來答對了」，而是那次錯誤本身不再成立：
   *   - 答案爭議待審，該題作答全部轉為暫記而不計入診斷；
   *   - 或裁決認定題庫答案有誤、重新判分後那筆根本就是答對的。
   * 這時留著紀錄等於宣稱「你這題錯過」，但依現有資料那並非事實。
   * 錯題紀錄是 user_answers 的衍生投影，來源沒了就不該留下投影；
   * 之後若爭議裁決回復原答案，同一份歷史會把紀錄原樣重算回來。
   */
  async recompute(tx: Database, userId: string, questionId: string): Promise<void> {
    const answers = await tx
      .select({
        isCorrect: schema.userAnswers.isCorrect,
        answeredAt: schema.userAnswers.answeredAt,
      })
      .from(schema.userAnswers)
      .where(
        and(
          eq(schema.userAnswers.userId, userId),
          eq(schema.userAnswers.questionId, questionId),
          // 爭議題待審期間的作答不計入能力診斷（FR-QUIZ-14）。
          eq(schema.userAnswers.isProvisional, false),
        ),
      )
      .orderBy(asc(schema.userAnswers.answeredAt), asc(schema.userAnswers.id));

    let progress: MistakeProgress | null = null;
    let firstMissedAt: Date | null = null;
    let lastMissedAt: Date | null = null;

    for (const answer of answers) {
      progress = applyAttempt(progress, answer.isCorrect);
      if (!answer.isCorrect) {
        firstMissedAt ??= answer.answeredAt;
        lastMissedAt = answer.answeredAt;
      }
    }

    if (progress === null) {
      await tx
        .delete(schema.mistakeRecords)
        .where(
          and(
            eq(schema.mistakeRecords.userId, userId),
            eq(schema.mistakeRecords.questionId, questionId),
          ),
        );
      return;
    }

    const recent = answers.slice(-RECENT_WINDOW).map((a) => a.isCorrect);
    const recentAccuracy = computeRecentAccuracy(recent);
    const lastAnsweredAt = answers.at(-1)?.answeredAt ?? null;

    const values = {
      mistakeCount: progress.mistakeCount,
      consecutiveCorrect: progress.consecutiveCorrect,
      // 直接數作答筆數，而不是由狀態機累加：
      // 第一次就答對的題目不會建立紀錄，狀態機看不到那次作答，
      // 累加的結果會比錯題詳情頁列出的歷次作答少一筆，看起來像資料掉了。
      totalAttempts: answers.length,
      recentAccuracy: recentAccuracy === null ? null : recentAccuracy.toFixed(4),
      masteryState: progress.masteryState,
      firstMissedAt,
      lastMissedAt,
      lastAnsweredAt,
      isResolved: progress.isResolved,
      updatedAt: new Date(),
    };

    await tx
      .insert(schema.mistakeRecords)
      .values({ userId, questionId, ...values })
      .onConflictDoUpdate({
        target: [schema.mistakeRecords.userId, schema.mistakeRecords.questionId],
        set: values,
      });
  }
}
