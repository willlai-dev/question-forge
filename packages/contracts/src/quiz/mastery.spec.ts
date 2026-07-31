import { describe, expect, it } from 'vitest';

import { applyAttempt, computeMasteryState, computeRecentAccuracy } from './mastery';

describe('computeMasteryState', () => {
  it.each([
    [0, 'active'],
    [1, 'improving'],
    [2, 'improving'],
    [3, 'mastered'],
    [10, 'mastered'],
  ])('連續答對 %i 次 → %s', (consecutive, expected) => {
    expect(computeMasteryState(consecutive)).toBe(expected);
  });

  it('負數視同 0（防禦性，不應該發生）', () => {
    expect(computeMasteryState(-1)).toBe('active');
  });
});

describe('applyAttempt', () => {
  it('沒有紀錄且答對 → 不建立紀錄', () => {
    expect(applyAttempt(null, true)).toBeNull();
  });

  it('沒有紀錄且答錯 → 建立紀錄並記錄一次錯誤', () => {
    expect(applyAttempt(null, false)).toEqual({
      mistakeCount: 1,
      consecutiveCorrect: 0,
      masteryState: 'active',
      isResolved: false,
    });
  });

  it('答對一次不刪除紀錄，只改變狀態（FR-MIS-05）', () => {
    const afterMiss = applyAttempt(null, false)!;
    const afterCorrect = applyAttempt(afterMiss, true);

    expect(afterCorrect).not.toBeNull();
    expect(afterCorrect!.mistakeCount).toBe(1);
    expect(afterCorrect!.masteryState).toBe('improving');
    expect(afterCorrect!.isResolved).toBe(true);
  });

  it('連續答對三次後進入 mastered', () => {
    let state = applyAttempt(null, false);
    for (let i = 0; i < 3; i += 1) state = applyAttempt(state, true);

    expect(state!.consecutiveCorrect).toBe(3);
    expect(state!.masteryState).toBe('mastered');
    expect(state!.mistakeCount).toBe(1);
  });

  it('任何一次答錯都把狀態打回 active 並累加錯誤次數', () => {
    let state = applyAttempt(null, false);
    for (let i = 0; i < 3; i += 1) state = applyAttempt(state, true);
    state = applyAttempt(state, false);

    expect(state!.masteryState).toBe('active');
    expect(state!.consecutiveCorrect).toBe(0);
    expect(state!.mistakeCount).toBe(2);
  });

  it('isResolved 一旦為 true 就不會再變回 false', () => {
    let state = applyAttempt(null, false);
    state = applyAttempt(state, true);
    state = applyAttempt(state, false);

    expect(state!.isResolved).toBe(true);
  });

  it('摺疊整份作答歷史的結果與逐次套用一致（錯題紀錄是衍生狀態）', () => {
    const history = [false, true, false, true, true, true];
    const folded = history.reduce<ReturnType<typeof applyAttempt>>(
      (acc, correct) => applyAttempt(acc, correct),
      null,
    );

    expect(folded).toEqual({
      mistakeCount: 2,
      consecutiveCorrect: 3,
      masteryState: 'mastered',
      isResolved: true,
    });
  });

  it('重複摺疊同一份歷史得到同一個結果（冪等，修改答案後重算不會漂移）', () => {
    const history = [false, true, false];
    const fold = () =>
      history.reduce<ReturnType<typeof applyAttempt>>(
        (acc, correct) => applyAttempt(acc, correct),
        null,
      );

    expect(fold()).toEqual(fold());
  });

  it('第一次就答對的題目，後來答錯才建立紀錄', () => {
    const state = [true, false].reduce<ReturnType<typeof applyAttempt>>(
      (acc, correct) => applyAttempt(acc, correct),
      null,
    );

    expect(state).toEqual({
      mistakeCount: 1,
      consecutiveCorrect: 0,
      masteryState: 'active',
      isResolved: false,
    });
  });
});

describe('computeRecentAccuracy', () => {
  it('沒有作答時回 null，而不是 0', () => {
    expect(computeRecentAccuracy([])).toBeNull();
  });

  it('全對為 1', () => {
    expect(computeRecentAccuracy([true, true])).toBe(1);
  });

  it('取到小數第四位', () => {
    expect(computeRecentAccuracy([true, false, false])).toBe(0.3333);
  });
});
