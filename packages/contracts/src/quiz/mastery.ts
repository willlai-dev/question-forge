/**
 * 錯題熟練狀態。
 *
 * 規格 §七（FR-MIS-05～07）要求規則「可解釋且可單元測試」，
 * 因此狀態轉移寫成純函式，service 只負責把結果寫進資料庫。
 */

export const MASTERY_STATES = ['active', 'improving', 'mastered'] as const;
export type MasteryState = (typeof MASTERY_STATES)[number];

/** 進入 mastered 所需的連續答對次數。 */
export const MASTERED_THRESHOLD = 3;

/**
 * 依連續答對次數決定熟練狀態。
 *
 * | 連續答對 | 狀態 |
 * |---|---|
 * | 0 | `active` |
 * | 1～2 | `improving` |
 * | ≥3 | `mastered` |
 */
export function computeMasteryState(consecutiveCorrect: number): MasteryState {
  if (consecutiveCorrect <= 0) return 'active';
  if (consecutiveCorrect < MASTERED_THRESHOLD) return 'improving';
  return 'mastered';
}

/**
 * 錯題紀錄的熟練狀態。
 *
 * 這裡刻意**不含** `totalAttempts`：那只是「這一題有幾筆作答」的計數，
 * 不屬於熟練狀態機。而且第一次就答對的題目不會建立紀錄，
 * 狀態機根本看不到那次作答，硬要在這裡累加就會與畫面上的歷次作答清單對不起來。
 * 總作答次數改由 service 直接數作答筆數（見 MistakeRecordsService.recompute）。
 */
export interface MistakeProgress {
  /** 累計答錯次數。只增不減。 */
  mistakeCount: number;
  /** 連續答對次數。任何一次答錯即歸零。 */
  consecutiveCorrect: number;
  masteryState: MasteryState;
  /** 是否曾經重新答對過。一旦為 true 就不再變回 false。 */
  isResolved: boolean;
}

/**
 * 套用一次作答結果。
 *
 * `current` 為 null 代表這題目前不在錯題本中：
 *   - 答對 → 回傳 null（**不會**因為答對就建立錯題紀錄）
 *   - 答錯 → 從零建立一筆新紀錄
 *
 * 已存在的紀錄則永遠回傳新狀態，**答對一次也不刪除**（FR-MIS-05）——
 * 錯題紀錄是學習歷程，不是待辦清單。
 */
export function applyAttempt(
  current: MistakeProgress | null,
  isCorrect: boolean,
): MistakeProgress | null {
  if (current === null && isCorrect) return null;

  const base: MistakeProgress = current ?? {
    mistakeCount: 0,
    consecutiveCorrect: 0,
    masteryState: 'active',
    isResolved: false,
  };

  if (isCorrect) {
    const consecutiveCorrect = base.consecutiveCorrect + 1;
    return {
      mistakeCount: base.mistakeCount,
      consecutiveCorrect,
      masteryState: computeMasteryState(consecutiveCorrect),
      isResolved: true,
    };
  }

  return {
    mistakeCount: base.mistakeCount + 1,
    consecutiveCorrect: 0,
    masteryState: computeMasteryState(0),
    isResolved: base.isResolved,
  };
}

/** 近 N 次作答的正確率，取到小數第四位；沒有紀錄時回 null。 */
export function computeRecentAccuracy(recentResults: readonly boolean[]): number | null {
  if (recentResults.length === 0) return null;
  const correct = recentResults.filter(Boolean).length;
  return Math.round((correct / recentResults.length) * 10000) / 10000;
}
