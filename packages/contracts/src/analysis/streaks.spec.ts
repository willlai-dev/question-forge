import { describe, expect, it } from 'vitest';

import { computeCurrentWrongStreaks, type StreakAttempt } from './streaks';

/** 由新到舊。 */
const attempt = (tag: string, isCorrect: boolean): StreakAttempt => ({
  knowledgeTagId: `id-${tag}`,
  knowledgeTagName: tag,
  isCorrect,
});

describe('computeCurrentWrongStreaks', () => {
  it('從未答對的知識點，連續數等於全部作答數', () => {
    const result = computeCurrentWrongStreaks([
      attempt('行政處分', false),
      attempt('行政處分', false),
      attempt('行政處分', false),
    ]);
    expect(result).toEqual([
      { knowledgeTagId: 'id-行政處分', knowledgeTagName: '行政處分', streak: 3 },
    ]);
  });

  it('最近答對了 → 連續錯誤歸零，不列出', () => {
    // 由新到舊：對、錯、錯、錯
    const result = computeCurrentWrongStreaks([
      attempt('行政處分', true),
      attempt('行政處分', false),
      attempt('行政處分', false),
      attempt('行政處分', false),
    ]);
    expect(result).toEqual([]);
  });

  it('只數到最近一次答對為止', () => {
    // 由新到舊：錯、錯、對、錯、錯、錯 → 當前連續錯 2
    const result = computeCurrentWrongStreaks([
      attempt('行政處分', false),
      attempt('行政處分', false),
      attempt('行政處分', true),
      attempt('行政處分', false),
      attempt('行政處分', false),
      attempt('行政處分', false),
    ]);
    expect(result).toEqual([
      { knowledgeTagId: 'id-行政處分', knowledgeTagName: '行政處分', streak: 2 },
    ]);
  });

  it('只錯一次不算連續，不列出', () => {
    const result = computeCurrentWrongStreaks([attempt('行政處分', false)]);
    expect(result).toEqual([]);
  });

  it('多個知識點交錯時互不污染', () => {
    // A：錯、錯（連續 2）／B：對之後就結算（0）
    const result = computeCurrentWrongStreaks([
      attempt('A', false),
      attempt('B', true),
      attempt('A', false),
      attempt('B', false),
      attempt('B', false),
    ]);
    expect(result).toEqual([{ knowledgeTagId: 'id-A', knowledgeTagName: 'A', streak: 2 }]);
  });

  it('多個知識點都連錯時，依連續數由多到少排序', () => {
    const result = computeCurrentWrongStreaks([
      attempt('A', false),
      attempt('B', false),
      attempt('B', false),
      attempt('B', false),
      attempt('A', false),
    ]);
    expect(result.map((r) => [r.knowledgeTagName, r.streak])).toEqual([
      ['B', 3],
      ['A', 2],
    ]);
  });

  it('空輸入回空陣列', () => {
    expect(computeCurrentWrongStreaks([])).toEqual([]);
  });
});
