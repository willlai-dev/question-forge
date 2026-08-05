/**
 * 作答中的題目導覽計算。
 *
 * 零 import 的純函式（與 `grading.ts`、`analysis/representative.ts` 同一個模式）：
 * 用「無法 import」在結構上證明它碰不到資料庫、時鐘與網路。
 */

/** 找下一題時只需要知道這兩件事。 */
export interface NavigableQuestion {
  position: number;
  answered: boolean;
}

/**
 * 從目前位置往後找第一個尚未作答的題目，找不到就從頭繞回來。
 *
 * 繞回來是刻意的：作答到一半跳著答時，未作答的題目往往落在前面。
 * 只往後找的話，答到後段就再也找不到前面漏掉的題目——
 * 而那正是這個功能最該幫上忙的時候。
 *
 * **目前這一題即使未作答也不算**，否則按下去會停在原地，看起來像沒有反應。
 * 全部都作答完則回傳 null，由呼叫端決定要不要提示。
 */
export function findNextUnanswered(
  questions: readonly NavigableQuestion[],
  currentPosition: number,
): number | null {
  if (questions.length === 0) return null;

  const sorted = [...questions].sort((a, b) => a.position - b.position);

  // 先往後找，再從頭找到目前位置為止——合起來剛好把每一題看過一次。
  const after = sorted.filter((q) => q.position > currentPosition && !q.answered);
  if (after.length > 0) return after[0]!.position;

  const before = sorted.filter((q) => q.position < currentPosition && !q.answered);
  if (before.length > 0) return before[0]!.position;

  return null;
}
