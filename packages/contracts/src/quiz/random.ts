/**
 * 出題與選項順序的隨機化。
 *
 * 全部以 seed 驅動：同一個 seed 永遠得到同一個順序。
 * 這讓「隨機」也能被單元測試斷言，而不是只能測「長度沒變」。
 * 場次的 seed 存在 `quiz_sessions.seed`，出題結果存在 `quiz_session_questions.option_order`，
 * 因此就算日後改了演算法，既有場次的顯示順序也不會跟著變。
 */

/** mulberry32：32 位元 seed 的小型 PRNG，分布足夠、實作短、可跨語言重現。 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 由場次 seed 推導出每一題各自的 seed。
 *
 * 若每題都直接用場次 seed，所有題目的選項會被打亂成同一種排列
 * （例如整份考卷的答案都從 C 變成 A），那就不是隨機化而是整體位移。
 */
export function deriveSeed(sessionSeed: number, position: number): number {
  return (Math.imul(sessionSeed >>> 0, 0x9e3779b1) + Math.imul(position + 1, 0x85ebca6b)) >>> 0;
}

/** Fisher-Yates 洗牌。不改動輸入陣列。 */
export function shuffleWithSeed<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  const rng = createRng(seed);
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/**
 * 決定一題的選項顯示順序。
 *
 * 回傳的是「選項代號的排列」，不是重新編號後的選項 ——
 * 使用者送回的永遠是真實代號，判分永遠比對 `correct_answers_snapshot`。
 * 顯示順序與判分因此完全解耦（docs/ERD.md §6）。
 */
export function buildOptionOrder(
  optionKeys: readonly string[],
  shuffle: boolean,
  sessionSeed: number,
  position: number,
): string[] {
  if (!shuffle) return [...optionKeys];
  return shuffleWithSeed(optionKeys, deriveSeed(sessionSeed, position));
}

/** 依出題策略決定題目順序。`sequential` 保留呼叫端給的順序。 */
export function applyOrderStrategy<T>(
  items: readonly T[],
  strategy: 'sequential' | 'random',
  sessionSeed: number,
): T[] {
  return strategy === 'random' ? shuffleWithSeed(items, sessionSeed) : [...items];
}

/** 產生新場次的 seed。這是唯一使用非決定性亂數的地方。 */
export function generateSessionSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}
