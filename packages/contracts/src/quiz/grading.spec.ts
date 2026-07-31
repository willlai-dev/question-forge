import { describe, expect, it } from 'vitest';

import { gradeAnswer, normalizeAnswerKeys } from './grading';

/**
 * 判分是整個系統唯一決定「對或錯」的地方，而且規格明令不得由 AI 參與（FR-QUIZ-10）。
 * 這裡把每一條規則都釘死，避免日後為了某個邊界情境「順手」放寬。
 */

describe('normalizeAnswerKeys', () => {
  it('去空白、轉大寫', () => {
    expect(normalizeAnswerKeys([' a ', 'b'])).toEqual(['A', 'B']);
  });

  it('去重', () => {
    expect(normalizeAnswerKeys(['A', 'A', 'B'])).toEqual(['A', 'B']);
  });

  it('排序，使順序不影響比較', () => {
    expect(normalizeAnswerKeys(['D', 'B', 'A'])).toEqual(['A', 'B', 'D']);
  });

  it('略過空字串', () => {
    expect(normalizeAnswerKeys(['A', '', '  '])).toEqual(['A']);
  });
});

describe('gradeAnswer — 單選題', () => {
  it('選中正確答案判為對', () => {
    expect(gradeAnswer(['B'], ['B'])).toBe(true);
  });

  it('選錯判為錯', () => {
    expect(gradeAnswer(['A'], ['B'])).toBe(false);
  });

  it('大小寫與空白不影響結果', () => {
    expect(gradeAnswer([' b '], ['B'])).toBe(true);
  });
});

describe('gradeAnswer — 複選題', () => {
  it('完全一致判為對', () => {
    expect(gradeAnswer(['A', 'C'], ['A', 'C'])).toBe(true);
  });

  it('順序不同仍判為對', () => {
    expect(gradeAnswer(['C', 'A'], ['A', 'C'])).toBe(true);
  });

  it('少選（部分正確）不給分', () => {
    expect(gradeAnswer(['A'], ['A', 'C'])).toBe(false);
  });

  it('多選不給分', () => {
    expect(gradeAnswer(['A', 'C', 'D'], ['A', 'C'])).toBe(false);
  });

  it('數量相同但內容不同判為錯', () => {
    expect(gradeAnswer(['A', 'B'], ['A', 'C'])).toBe(false);
  });

  it('重複選同一個選項不會被當成多選', () => {
    expect(gradeAnswer(['A', 'A', 'C'], ['A', 'C'])).toBe(true);
  });
});

describe('gradeAnswer — 邊界情境', () => {
  it('沒有作答判為錯', () => {
    expect(gradeAnswer([], ['B'])).toBe(false);
  });

  it('正確答案為空時一律判為錯，不會因為「兩邊都空」而誤判為答對', () => {
    // 這是資料異常（題目沒有正確答案），不是使用者答對了。
    expect(gradeAnswer([], [])).toBe(false);
    expect(gradeAnswer(['A'], [])).toBe(false);
  });
});
