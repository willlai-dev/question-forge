/**
 * 正確率換算。
 *
 * 刻意與 `quiz/mastery.ts` 的 `computeRecentAccuracy` 分開，兩者單位不同：
 *   - 這裡回傳 0～100（百分比，2 位小數），供統計與畫面顯示。
 *   - `computeRecentAccuracy` 回傳 0～1（4 位小數），寫進 `mistake_records.recent_accuracy`。
 * 混用會讓「85」被當成 8500% 或「0.85」被當成 0.85%，因此不共用。
 */

/**
 * 算百分比。**分母為 0 時回傳 `null` 而非 `0`**。
 *
 * 「沒作答」與「全部答錯」是完全不同的兩件事，塌縮成同一個 0 會讓
 * 診斷把「沒有資料」講成「你這科考 0 分」。
 */
export function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10000) / 100;
}
