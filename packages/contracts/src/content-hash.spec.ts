import { describe, expect, it } from 'vitest';

import {
  computeNoteContentHash,
  computeNotesFingerprint,
  computeQuestionContentHash,
} from './content-hash';

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

/**
 * 章節筆記指紋。
 *
 * questionContentHash 只涵蓋題目本身：筆記重新匯入後題目沒變、雜湊不變，
 * 舊解析會繼續命中快取——使用者改了筆記卻看不到任何差別，也沒有跡象說明為什麼。
 */
describe('computeNotesFingerprint', () => {
  const n = (id: string, contentHash: string) => ({ id, contentHash });

  it('空集合有固定且明確的值', () => {
    expect(computeNotesFingerprint([])).toBe('no-notes');
  });

  it('**順序不影響指紋**（檢索順序變動不代表依據的內容變了）', () => {
    const a = computeNotesFingerprint([n('id-1', 'h1'), n('id-2', 'h2')]);
    const b = computeNotesFingerprint([n('id-2', 'h2'), n('id-1', 'h1')]);
    expect(a).toBe(b);
  });

  it('筆記內容改了 → 指紋改變（快取才會失效）', () => {
    const before = computeNotesFingerprint([n('id-1', 'h1')]);
    const after = computeNotesFingerprint([n('id-1', 'h1-modified')]);
    expect(after).not.toBe(before);
  });

  it('多帶一段筆記 → 指紋改變', () => {
    const one = computeNotesFingerprint([n('id-1', 'h1')]);
    const two = computeNotesFingerprint([n('id-1', 'h1'), n('id-2', 'h2')]);
    expect(two).not.toBe(one);
  });

  it('有筆記與沒筆記絕不會撞在一起', () => {
    expect(computeNotesFingerprint([n('id-1', 'h1')])).not.toBe('no-notes');
  });
});

describe('computeNoteContentHash', () => {
  it('只有空白差異視為同一份內容', () => {
    expect(computeNoteContentHash('期貨  交易稅\n規定')).toBe(
      computeNoteContentHash('期貨 交易稅 規定'),
    );
  });

  it('實質內容不同就是不同的雜湊', () => {
    expect(computeNoteContentHash('十萬分之2')).not.toBe(computeNoteContentHash('十萬分之3'));
  });
});
