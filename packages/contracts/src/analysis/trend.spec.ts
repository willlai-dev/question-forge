import { describe, expect, it } from 'vitest';

import {
  classifyTrend,
  MIN_TREND_SAMPLES,
  TREND_SIGNIFICANT_PP,
  WEAK_ACCURACY_PCT,
} from './trend';

describe('classifyTrend', () => {
  it('任一半段樣本不足 → insufficient，且 trend 是 null 不是 0', () => {
    const result = classifyTrend({
      earlierAnswered: MIN_TREND_SAMPLES - 1,
      earlierCorrect: 2,
      recentAnswered: 20,
      recentCorrect: 18,
    });
    expect(result.verdict).toBe('insufficient');
    // 分開斷言：null（沒資料）與 0（沒變化）不能塌縮成同一個值。
    expect(result.trend).toBeNull();
    expect(result.trend).not.toBe(0);
  });

  it('後半段樣本不足也算 insufficient', () => {
    const result = classifyTrend({
      earlierAnswered: 20,
      earlierCorrect: 10,
      recentAnswered: MIN_TREND_SAMPLES - 1,
      recentCorrect: 4,
    });
    expect(result.verdict).toBe('insufficient');
    expect(result.trend).toBeNull();
  });

  it('兩段都是 0 筆 → insufficient，不會除以零', () => {
    const result = classifyTrend({
      earlierAnswered: 0,
      earlierCorrect: 0,
      recentAnswered: 0,
      recentCorrect: 0,
    });
    expect(result.verdict).toBe('insufficient');
    expect(result.trend).toBeNull();
    expect(result.earlierAccuracy).toBeNull();
  });

  it('剛好達到 +10 個百分點 → improved（邊界含等於）', () => {
    // 前半 10 題對 5 → 50%；後半 10 題對 6 → 60%；差 +10.00
    const result = classifyTrend({
      earlierAnswered: 10,
      earlierCorrect: 5,
      recentAnswered: 10,
      recentCorrect: 6,
    });
    expect(result.trend).toBe(TREND_SIGNIFICANT_PP);
    expect(result.verdict).toBe('improved');
  });

  it('剛好 -10 個百分點 → not_improved（邊界含等於）', () => {
    const result = classifyTrend({
      earlierAnswered: 10,
      earlierCorrect: 6,
      recentAnswered: 10,
      recentCorrect: 5,
    });
    expect(result.trend).toBe(-TREND_SIGNIFICANT_PP);
    expect(result.verdict).toBe('not_improved');
  });

  it('持平但仍低於薄弱門檻 → not_improved', () => {
    // 兩段都 50%，低於 WEAK_ACCURACY_PCT
    const result = classifyTrend({
      earlierAnswered: 10,
      earlierCorrect: 5,
      recentAnswered: 10,
      recentCorrect: 5,
    });
    expect(result.trend).toBe(0);
    expect(result.recentAccuracy).toBeLessThan(WEAK_ACCURACY_PCT);
    expect(result.verdict).toBe('not_improved');
  });

  it('持平且已在高檔 → stable_ok（不需要提醒）', () => {
    const result = classifyTrend({
      earlierAnswered: 10,
      earlierCorrect: 9,
      recentAnswered: 10,
      recentCorrect: 9,
    });
    expect(result.trend).toBe(0);
    expect(result.verdict).toBe('stable_ok');
  });

  it('大幅進步', () => {
    const result = classifyTrend({
      earlierAnswered: 10,
      earlierCorrect: 2,
      recentAnswered: 10,
      recentCorrect: 9,
    });
    expect(result.trend).toBe(70);
    expect(result.verdict).toBe('improved');
  });
});
