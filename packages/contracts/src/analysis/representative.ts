/**
 * 代表錯題挑選（規格 §11 FR-AGG-03）。
 *
 * **本檔刻意零 import**，與 `quiz/grading.ts` 同一個做法：
 * 用「結構上無法引用」證明挑選過程碰不到 AI、資料庫與時鐘。
 * 需要 Zod schema 的話請放 `api/stats.ts`，不要在這裡引入依賴。
 *
 * 規格要求「不應直接將所有完整題目一次傳給模型」，所以先由 PostgreSQL 統計，
 * 再用這支函式挑出最多 15 題送進 prompt。
 */

/** 一次分析最多送幾題。與 migration 的 CHECK 約束是同一個數字，改動要一起改。 */
export const REPRESENTATIVE_QUESTION_LIMIT = 15;

/** 同一個主要知識點最多佔幾個名額，避免單一弱點吃光整份診斷。 */
export const REPRESENTATIVE_MAX_PER_TAG = 3;

/** 單題答錯次數對分數的貢獻上限，避免一題狂錯就壟斷全部名額。 */
export const WRONG_COUNT_SCORE_CAP = 5;

export interface RepresentativeCandidate {
  questionId: string;
  /** 期間內答錯次數。 */
  wrongCount: number;
  /** 期間內作答次數。 */
  attemptCount: number;
  masteryState: 'active' | 'improving' | 'mastered';
  knowledgeTagIds: readonly string[];
  primaryKnowledgeTagId: string | null;
  errorTypeCodes: readonly string[];
  /** 期間內最後一次答錯的時間（ISO 字串）。沒答錯過則為 null。 */
  lastMissedAt: string | null;
  questionNumber: number;
}

/** 知識點的整體表現，用來加權「這題屬於很弱的概念」。 */
export interface TagWeight {
  tagId: string;
  /** 0～100。`null` 代表沒有資料，不等於 0 分。 */
  accuracy: number | null;
  answered: number;
}

export interface SelectRepresentativeInput {
  candidates: readonly RepresentativeCandidate[];
  tagStats: readonly TagWeight[];
  limit?: number;
  maxPerTag?: number;
}

export interface ScoredCandidate {
  questionId: string;
  score: number;
  /** 給人看的計分理由，會一併存進 stats_snapshot。 */
  reasons: string[];
}

export interface RepresentativeSelection {
  questionIds: string[];
  scored: ScoredCandidate[];
}

/**
 * 算單題分數。**全部用整數**——浮點捨入會憑空製造或消滅平手，
 * 而平手的處理正是決定性的關鍵。
 */
function scoreCandidate(
  candidate: RepresentativeCandidate,
  accuracyByTag: ReadonlyMap<string, number>,
): ScoredCandidate {
  const reasons: string[] = [];
  let score = 0;

  const cappedWrong = Math.min(candidate.wrongCount, WRONG_COUNT_SCORE_CAP);
  if (cappedWrong > 0) {
    score += 100 * cappedWrong;
    reasons.push(`答錯 ${candidate.wrongCount} 次`);
  }

  if (candidate.masteryState === 'active') {
    score += 60;
    reasons.push('尚未開始改善');
  }

  // 取這題所屬知識點中「最弱」的那個當權重。沒有資料的標籤不參與，
  // 否則 null 會被當成 0 分而讓「沒練過」偽裝成「很弱」。
  let weakest: number | null = null;
  for (const tagId of candidate.knowledgeTagIds) {
    const accuracy = accuracyByTag.get(tagId);
    if (accuracy === undefined) continue;
    if (weakest === null || accuracy < weakest) weakest = accuracy;
  }
  if (weakest !== null) {
    score += Math.round(100 - weakest);
    reasons.push(`所屬知識點正確率 ${weakest}%`);
  }

  if (candidate.errorTypeCodes.length > 0) {
    score += 20;
    reasons.push('已標記錯誤類型');
  }

  return { questionId: candidate.questionId, score, reasons };
}

/**
 * 排序比較子。
 *
 * 最後一層一定要是 `questionId`，讓排序成為**全序**。
 * 少了它，兩題在其他條件完全相同時會退回資料庫的回傳順序，
 * 而 PostgreSQL 不保證跨次一致——同一份統計會挑出不同的 15 題，
 * `stats_snapshot` 就不再可重現，FR-AGG-05 形同虛設。
 */
function compareCandidates(
  a: RepresentativeCandidate,
  b: RepresentativeCandidate,
  scores: ReadonlyMap<string, number>,
): number {
  const scoreDiff = (scores.get(b.questionId) ?? 0) - (scores.get(a.questionId) ?? 0);
  if (scoreDiff !== 0) return scoreDiff;

  if (a.wrongCount !== b.wrongCount) return b.wrongCount - a.wrongCount;

  // ISO 字串可直接字典序比較；null（從沒答錯）排最後。
  if (a.lastMissedAt !== b.lastMissedAt) {
    if (a.lastMissedAt === null) return 1;
    if (b.lastMissedAt === null) return -1;
    return a.lastMissedAt < b.lastMissedAt ? 1 : -1;
  }

  if (a.questionNumber !== b.questionNumber) return a.questionNumber - b.questionNumber;

  return a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0;
}

/**
 * 依統計權重挑出代表錯題。
 *
 * 決定性保證：輸出只取決於輸入的**內容**，與輸入的**順序**無關。
 * 同一份統計永遠挑出同一組題目、同樣的排列。
 */
export function selectRepresentativeQuestions(
  input: SelectRepresentativeInput,
): RepresentativeSelection {
  const limit = input.limit ?? REPRESENTATIVE_QUESTION_LIMIT;
  const maxPerTag = input.maxPerTag ?? REPRESENTATIVE_MAX_PER_TAG;

  const accuracyByTag = new Map<string, number>();
  for (const tag of input.tagStats) {
    if (tag.accuracy !== null) accuracyByTag.set(tag.tagId, tag.accuracy);
  }

  const scored = input.candidates.map((candidate) => scoreCandidate(candidate, accuracyByTag));
  const scoreById = new Map(scored.map((entry) => [entry.questionId, entry.score]));

  const sorted = [...input.candidates].sort((a, b) => compareCandidates(a, b, scoreById));

  // 第一輪照配額取，被擋下的留到第二輪回填，兩輪都走同一個排序 → 仍然決定性。
  const perTagCount = new Map<string, number>();
  const picked: RepresentativeCandidate[] = [];
  const overflow: RepresentativeCandidate[] = [];

  for (const candidate of sorted) {
    if (picked.length >= limit) break;
    const tagId = candidate.primaryKnowledgeTagId;
    if (tagId === null) {
      picked.push(candidate);
      continue;
    }
    const used = perTagCount.get(tagId) ?? 0;
    if (used >= maxPerTag) {
      overflow.push(candidate);
      continue;
    }
    perTagCount.set(tagId, used + 1);
    picked.push(candidate);
  }

  for (const candidate of overflow) {
    if (picked.length >= limit) break;
    picked.push(candidate);
  }

  const pickedIds = new Set(picked.map((candidate) => candidate.questionId));

  return {
    questionIds: picked.map((candidate) => candidate.questionId),
    // scored 依最終排序輸出，且只含被選中的題目——存進 snapshot 時才對得起來。
    scored: sorted
      .filter((candidate) => pickedIds.has(candidate.questionId))
      .map((candidate) => scored.find((entry) => entry.questionId === candidate.questionId)!),
  };
}
