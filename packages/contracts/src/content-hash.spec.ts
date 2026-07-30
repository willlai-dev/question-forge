import { describe, expect, it } from 'vitest';

import { computeQuestionContentHash } from './content-hash';

const base = {
  type: 'single_choice',
  stem: '下列何者屬於行政處分？',
  options: [
    { key: 'A', text: '行政指導', isCorrect: false },
    { key: 'B', text: '拆除命令', isCorrect: true },
  ],
};

describe('computeQuestionContentHash', () => {
  it('相同內容產生相同雜湊', () => {
    expect(computeQuestionContentHash(base)).toBe(computeQuestionContentHash({ ...base }));
  });

  it('題幹變更 → 雜湊改變', () => {
    expect(computeQuestionContentHash({ ...base, stem: '換一個題幹' })).not.toBe(
      computeQuestionContentHash(base),
    );
  });

  it('選項文字變更 → 雜湊改變', () => {
    const changed = {
      ...base,
      options: [base.options[0]!, { ...base.options[1]!, text: '改過的選項' }],
    };
    expect(computeQuestionContentHash(changed)).not.toBe(computeQuestionContentHash(base));
  });

  it('正確答案變更 → 雜湊改變', () => {
    const changed = {
      ...base,
      options: [
        { ...base.options[0]!, isCorrect: true },
        { ...base.options[1]!, isCorrect: false },
      ],
    };
    expect(computeQuestionContentHash(changed)).not.toBe(computeQuestionContentHash(base));
  });

  it('題型變更 → 雜湊改變', () => {
    expect(computeQuestionContentHash({ ...base, type: 'multiple_choice' })).not.toBe(
      computeQuestionContentHash(base),
    );
  });

  it('只調整選項順序 → 雜湊不變（作答時的選項隨機化不應觸發重新分析）', () => {
    const reordered = { ...base, options: [base.options[1]!, base.options[0]!] };
    expect(computeQuestionContentHash(reordered)).toBe(computeQuestionContentHash(base));
  });

  it('前後空白與連續空白被正規化', () => {
    const messy = {
      ...base,
      stem: '  下列何者屬於行政處分？  ',
      options: [
        { key: 'A', text: ' 行政指導 ', isCorrect: false },
        { key: 'B', text: '拆除命令', isCorrect: true },
      ],
    };
    expect(computeQuestionContentHash(messy)).toBe(computeQuestionContentHash(base));
  });

  it('選項代號大小寫不影響結果', () => {
    const lower = {
      ...base,
      options: base.options.map((o) => ({ ...o, key: o.key.toLowerCase() })),
    };
    expect(computeQuestionContentHash(lower)).toBe(computeQuestionContentHash(base));
  });

  it('解析不納入雜湊（解析變動不需重新研究題目）', () => {
    // 介面本身不接受 explanation，此測試以型別層面保證：
    // 傳入額外欄位不會改變結果。
    const withExtra = { ...base, explanation: '一段解析' } as typeof base;
    expect(computeQuestionContentHash(withExtra)).toBe(computeQuestionContentHash(base));
  });

  it('輸出為 64 字元的十六進位字串（sha256）', () => {
    expect(computeQuestionContentHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
