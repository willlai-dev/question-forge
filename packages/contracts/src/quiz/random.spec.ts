import { describe, expect, it } from 'vitest';

import { gradeAnswer } from './grading';
import { applyOrderStrategy, buildOptionOrder, createRng, deriveSeed, shuffleWithSeed } from './random';

/**
 * 規格 §18 明列必須測「選項順序隨機後的答案映射」。
 * 這裡的重點不是「有沒有被打亂」，而是**打亂後判分仍然正確** ——
 * 選項隨機化最危險的失敗方式是靜默地把答案對應錯，而不是報錯。
 */

describe('createRng', () => {
  it('同一個 seed 產生同一串數列', () => {
    const a = createRng(42);
    const b = createRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('不同 seed 產生不同數列', () => {
    expect(createRng(1)()).not.toBe(createRng(2)());
  });

  it('輸出落在 [0, 1)', () => {
    const rng = createRng(12345);
    for (let i = 0; i < 200; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('shuffleWithSeed', () => {
  const keys = ['A', 'B', 'C', 'D'];

  it('不改動輸入陣列', () => {
    const input = [...keys];
    shuffleWithSeed(input, 7);
    expect(input).toEqual(keys);
  });

  it('元素完全保留，不多不少', () => {
    expect([...shuffleWithSeed(keys, 7)].sort()).toEqual([...keys].sort());
  });

  it('同一個 seed 得到同一個排列（可重現）', () => {
    expect(shuffleWithSeed(keys, 99)).toEqual(shuffleWithSeed(keys, 99));
  });

  it('空陣列與單一元素安全處理', () => {
    expect(shuffleWithSeed([], 1)).toEqual([]);
    expect(shuffleWithSeed(['A'], 1)).toEqual(['A']);
  });
});

describe('deriveSeed', () => {
  it('同一場次的不同題目得到不同 seed', () => {
    // 若每題共用場次 seed，整份考卷會被套用同一種排列（例如答案全都從 C 移到 A）。
    const seeds = new Set([1, 2, 3, 4, 5].map((position) => deriveSeed(1000, position)));
    expect(seeds.size).toBe(5);
  });

  it('同場次同題號可重現', () => {
    expect(deriveSeed(1000, 3)).toBe(deriveSeed(1000, 3));
  });
});

describe('buildOptionOrder', () => {
  const keys = ['A', 'B', 'C', 'D'];

  it('shuffle = false 時原樣保留', () => {
    expect(buildOptionOrder(keys, false, 123, 1)).toEqual(keys);
  });

  it('shuffle = true 時仍包含全部選項', () => {
    expect([...buildOptionOrder(keys, true, 123, 1)].sort()).toEqual(keys);
  });

  it('同一場次中至少有一題的順序真的被改變', () => {
    const changed = [1, 2, 3, 4, 5, 6, 7, 8].some(
      (position) => buildOptionOrder(keys, true, 20260731, position).join('') !== 'ABCD',
    );
    expect(changed).toBe(true);
  });
});

describe('選項隨機化後的答案映射', () => {
  it('打亂顯示順序不影響判分：使用者送回的是真實代號', () => {
    const keys = ['A', 'B', 'C', 'D'];
    const correctAnswers = ['C'];

    for (let position = 1; position <= 50; position += 1) {
      const displayOrder = buildOptionOrder(keys, true, 777, position);

      // 使用者「點了畫面上第一個選項」——那個位置對應的真實代號才是送回後端的值。
      const firstOnScreen = displayOrder[0]!;
      expect(gradeAnswer([firstOnScreen], correctAnswers)).toBe(firstOnScreen === 'C');

      // 不論排到第幾個位置，選中 C 永遠是對的。
      expect(gradeAnswer(['C'], correctAnswers)).toBe(true);
    }
  });

  it('複選題在選項打亂後，依畫面順序回報答案仍判為正確', () => {
    const keys = ['A', 'B', 'C', 'D', 'E'];
    const correctAnswers = ['B', 'D'];

    // 逐一檢查所有題號，確保沒有任何一種排列會讓「由上而下勾選正確選項」被判為錯。
    for (let position = 1; position <= 30; position += 1) {
      const displayOrder = buildOptionOrder(keys, true, 555, position);
      const selectedInScreenOrder = displayOrder.filter((key) => correctAnswers.includes(key));
      expect(gradeAnswer(selectedInScreenOrder, correctAnswers)).toBe(true);
    }

    // 且確實有出現「畫面順序與正確答案順序相反」的排列，證明上面不是空轉。
    const reversedSomewhere = Array.from({ length: 30 }, (_, i) =>
      buildOptionOrder(keys, true, 555, i + 1).filter((key) => correctAnswers.includes(key)),
    ).some((selected) => selected.join('') === 'DB');
    expect(reversedSomewhere).toBe(true);
  });
});

describe('applyOrderStrategy', () => {
  const questions = [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }, { id: 'q4' }];

  it('sequential 完全保留輸入順序', () => {
    expect(applyOrderStrategy(questions, 'sequential', 12345)).toEqual(questions);
  });

  it('random 保留全部題目', () => {
    const result = applyOrderStrategy(questions, 'random', 12345);
    expect(result).toHaveLength(questions.length);
    expect(new Set(result.map((q) => q.id))).toEqual(new Set(questions.map((q) => q.id)));
  });

  it('random 以 seed 決定，可重現', () => {
    expect(applyOrderStrategy(questions, 'random', 999)).toEqual(
      applyOrderStrategy(questions, 'random', 999),
    );
  });
});
