import { describe, expect, it } from 'vitest';

import { normalizeForQuoteMatch, verifyCitationQuotes } from './quote-verification';

/**
 * 引用原文查核。
 *
 * 目標是「AI 不能把來源沒說過的話算在該來源頭上」，不是排版忠實度。
 *
 * 第一版做逐位元組比對（只去空白），在真實 NVIDIA + Tavily 的執行中大量誤殺。
 * 這一組測試的每一條 markdown 案例都是從那次失敗的真實資料抄下來的。
 */

const SSGA = [
  'The median expense ratio for index ETFs is typically lower than that of',
  ' [index mutual funds](/us/en/individual/resources/education/etfs-vs-mutual-funds),',
  ' historically 0.56% for',
].join('');

const CRR =
  'By shifting investment options from managed mutual funds to exchange-traded funds (ETFs)' +
  ' or commingled trusts, 401(k) plans can align the fees they pay more closely with the expense' +
  ' of the services they use.';

const contents = new Map([
  ['S1', CRR],
  ['S6', SSGA],
]);

const cite = (sourceId: string, quote: string | null) => ({ sourceId, quote });

describe('verifyCitationQuotes', () => {
  it('**忠實引用時還原 markdown 連結 → 通過**（實際誤殺過的案例）', () => {
    // 來源是 [index mutual funds](/us/en/...)，模型引用時會寫成 index mutual funds。
    const quote =
      'The median expense ratio for index ETFs is typically lower than that of index mutual funds, historically 0.56%';
    expect(verifyCitationQuotes([cite('S6', quote)], contents)).toEqual([]);
  });

  it('逐字引用（含 markdown 原樣）也通過', () => {
    expect(verifyCitationQuotes([cite('S6', SSGA)], contents)).toEqual([]);
  });

  it('跨越 markdown 標記的長引用 → 通過', () => {
    const quote =
      'By shifting investment options from managed mutual funds to exchange-traded funds (ETFs) or commingled trusts, 401(k) plans can align the fees';
    expect(verifyCitationQuotes([cite('S1', quote)], contents)).toEqual([]);
  });

  it('大小寫差異不算捏造', () => {
    expect(verifyCitationQuotes([cite('S1', 'BY SHIFTING INVESTMENT OPTIONS')], contents)).toEqual(
      [],
    );
  });

  it('彎引號與破折號差異不算捏造', () => {
    const source = new Map([['S1', '“exchange‑traded” funds are cheaper']]);
    expect(verifyCitationQuotes([cite('S1', '"exchange-traded" funds')], source)).toEqual([]);
  });

  it('粗體與標題記號不算差異', () => {
    const source = new Map([['S1', '## ETF fees\n\nThe **median** expense ratio is low.']]);
    expect(verifyCitationQuotes([cite('S1', 'The median expense ratio is low.')], source)).toEqual(
      [],
    );
  });

  // --- 仍然要擋得住的 ---

  it('**憑空捏造的內容 → 抓出來**', () => {
    const result = verifyCitationQuotes(
      [cite('S1', 'ETFs are legally required to outperform mutual funds')],
      contents,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.sourceId).toBe('S1');
  });

  it('**改動數字 → 抓出來**（正規化不涵蓋語意）', () => {
    const result = verifyCitationQuotes(
      [cite('S6', 'The median expense ratio for index ETFs ... historically 0.99%')],
      contents,
    );
    expect(result).toHaveLength(1);
  });

  it('**張冠李戴：內容屬於另一份來源 → 抓出來**', () => {
    const result = verifyCitationQuotes([cite('S6', 'By shifting investment options')], contents);
    expect(result).toHaveLength(1);
    expect(result[0]!.sourceId).toBe('S6');
  });

  it('省略號串接時每一段都要對得上', () => {
    expect(
      verifyCitationQuotes(
        [cite('S1', 'By shifting investment options…401(k) plans can align the fees')],
        contents,
      ),
    ).toEqual([]);
    expect(
      verifyCitationQuotes(
        [cite('S1', 'By shifting investment options…the SEC mandates disclosure')],
        contents,
      ),
    ).toHaveLength(1);
  });

  it('quote 為 null → 通過（模型無法逐字引用時的合法選擇）', () => {
    expect(verifyCitationQuotes([cite('S1', null)], contents)).toEqual([]);
  });

  it('sourceId 不存在時略過，不重複回報', () => {
    // 那由 refineSourceIds 負責，這裡不製造第二筆噪音。
    expect(verifyCitationQuotes([cite('S99', '任何內容')], contents)).toEqual([]);
  });

  it('回報的 index 對得上原陣列位置', () => {
    const result = verifyCitationQuotes(
      [cite('S1', 'By shifting investment options'), cite('S1', '完全捏造的句子')],
      contents,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.index).toBe(1);
  });

  it('空引用清單不會爆炸', () => {
    expect(verifyCitationQuotes([], contents)).toEqual([]);
  });
});

describe('normalizeForQuoteMatch', () => {
  it('markdown 連結還原成顯示文字', () => {
    expect(normalizeForQuoteMatch('see [the docs](https://x.com/a?b=1) now')).toBe(
      'seethedocsnow',
    );
  });

  it('圖片語法也還原', () => {
    expect(normalizeForQuoteMatch('![alt text](/img.png)')).toBe('alttext');
  });

  it('強調與標題記號被移除', () => {
    expect(normalizeForQuoteMatch('## **bold** and `code`')).toBe('boldandcode');
  });

  it('不會把語意內容一起吃掉', () => {
    // 正規化只碰排版，數字與文字必須完整保留。
    expect(normalizeForQuoteMatch('0.56% vs 0.99%')).toBe('0.56%vs0.99%');
  });
});
