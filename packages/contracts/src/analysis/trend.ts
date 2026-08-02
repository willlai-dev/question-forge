/**
 * 進步／退步的判定。
 *
 * 規格 §11 要求「近期正確率變化」與「已改善與未改善項目」，但沒有定義怎麼算。
 * 這裡把定義集中成一支純函式，讓前端圖例、AI prompt 與測試共用同一份門檻，
 * 不會出現「畫面說進步、AI 說退步」。
 */

import { percent } from './percent';

/** 前後兩段各自至少要有這麼多筆作答，才敢下判斷。 */
export const MIN_TREND_SAMPLES = 5;

/** 視為「有變化」的百分點門檻。低於此視為持平。 */
export const TREND_SIGNIFICANT_PP = 10;

/** 低於此正確率視為仍然薄弱，即使沒有退步也算「未改善」。 */
export const WEAK_ACCURACY_PCT = 60;

export const TREND_VERDICTS = ['improved', 'not_improved', 'stable_ok', 'insufficient'] as const;
export type TrendVerdict = (typeof TREND_VERDICTS)[number];

export interface TrendInput {
  /** 期間前半段的作答數與答對數。 */
  earlierAnswered: number;
  earlierCorrect: number;
  /** 期間後半段的作答數與答對數。 */
  recentAnswered: number;
  recentCorrect: number;
}

export interface TrendResult {
  /** 後半段減前半段，單位為百分點（2 位小數）。資料不足時為 `null`。 */
  trend: number | null;
  verdict: TrendVerdict;
  earlierAccuracy: number | null;
  recentAccuracy: number | null;
}

/**
 * 比較期間前半段與後半段的正確率。
 *
 * 為什麼用「期間自身的中點」切半，而不是「最近 7 天 vs 前 7 天」：
 * 這樣每個趨勢數字都只是 `(from, to)` 的函式，`stats_snapshot` 單看那一列就能完整重現
 * （FR-AGG-05 要的正是這個）。固定天數的窗格在使用者選 3 天期間時就失效，
 * 而且得把額外參數塞進 snapshot 才說得清楚。
 *
 * 資料不足時 `trend` 回 `null` 而非 `0`：
 * 「沒有變化」與「沒有資料」不能是同一個數字，否則 AI 會把無話可說寫成停滯不前。
 */
export function classifyTrend(input: TrendInput): TrendResult {
  const earlierAccuracy = percent(input.earlierCorrect, input.earlierAnswered);
  const recentAccuracy = percent(input.recentCorrect, input.recentAnswered);

  const insufficient =
    input.earlierAnswered < MIN_TREND_SAMPLES ||
    input.recentAnswered < MIN_TREND_SAMPLES ||
    earlierAccuracy === null ||
    recentAccuracy === null;

  if (insufficient) {
    return { trend: null, verdict: 'insufficient', earlierAccuracy, recentAccuracy };
  }

  const trend = Math.round((recentAccuracy - earlierAccuracy) * 100) / 100;

  if (trend >= TREND_SIGNIFICANT_PP) {
    return { trend, verdict: 'improved', earlierAccuracy, recentAccuracy };
  }
  if (trend <= -TREND_SIGNIFICANT_PP) {
    return { trend, verdict: 'not_improved', earlierAccuracy, recentAccuracy };
  }
  // 持平：還是要看停在哪個高度。停在 85% 不需要提醒，停在 45% 要。
  return {
    trend,
    verdict: recentAccuracy < WEAK_ACCURACY_PCT ? 'not_improved' : 'stable_ok',
    earlierAccuracy,
    recentAccuracy,
  };
}
