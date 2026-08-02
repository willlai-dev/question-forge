/**
 * 各知識點的「當前連續答錯次數」。
 *
 * 資料庫沒有這個欄位：`mistake_records.consecutive_correct` 只追蹤連續**答對**，
 * 而 `mistake_count` 是終身累計、不是連續數。因此只能由作答歷史推導。
 *
 * 實作用摺疊而非 SQL window function，理由與 `MistakeRecordsService.recompute`
 * 相同：錯題狀態本來就是作答歷史的衍生結果，摺疊是這個 repo 已在用的做法，
 * 也讓這段最容易算錯的邏輯留在可單元測試的純函式裡。
 */

/** 低於這個長度不算「連續答錯」——錯一次只是錯一次，正確率統計已經涵蓋了。 */
export const CONSECUTIVE_WRONG_MIN_STREAK = 2;

/** 一筆作答對某個知識點的貢獻。呼叫端必須**由新到舊**排好。 */
export interface StreakAttempt {
  knowledgeTagId: string;
  knowledgeTagName: string;
  isCorrect: boolean;
}

export interface WrongStreak {
  knowledgeTagId: string;
  knowledgeTagName: string;
  streak: number;
}

/**
 * 算出每個知識點「到目前為止還沒答對」的連續錯誤數。
 *
 * 取當前連續數而非期間內的最長連續數：
 * 「這個知識點你連錯 4 題、到現在還沒對過」可以馬上行動；
 * 「你某個時候連錯過 4 題」則不行——可能早就練起來了。
 *
 * @param attempts 由新到舊排序的作答。同一筆作答若掛多個知識點，
 *                 呼叫端要為每個知識點各給一筆。
 */
export function computeCurrentWrongStreaks(
  attempts: readonly StreakAttempt[],
): WrongStreak[] {
  const streaks = new Map<string, { name: string; streak: number }>();
  // 一旦看到某個知識點的答對紀錄，它的連續錯誤就結算了，之後再舊的都不算。
  const settled = new Set<string>();

  for (const attempt of attempts) {
    if (settled.has(attempt.knowledgeTagId)) continue;

    if (attempt.isCorrect) {
      settled.add(attempt.knowledgeTagId);
      continue;
    }

    const current = streaks.get(attempt.knowledgeTagId);
    if (current) current.streak += 1;
    else streaks.set(attempt.knowledgeTagId, { name: attempt.knowledgeTagName, streak: 1 });
  }

  return [...streaks.entries()]
    .filter(([, value]) => value.streak >= CONSECUTIVE_WRONG_MIN_STREAK)
    .map(([knowledgeTagId, value]) => ({
      knowledgeTagId,
      knowledgeTagName: value.name,
      streak: value.streak,
    }))
    .sort((a, b) =>
      b.streak - a.streak ||
      a.knowledgeTagName.localeCompare(b.knowledgeTagName) ||
      (a.knowledgeTagId < b.knowledgeTagId ? -1 : a.knowledgeTagId > b.knowledgeTagId ? 1 : 0),
    );
}
