import { describe, expect, it } from 'vitest';

import {
  rankNotesForQuestion,
  selectNotesWithinBudget,
  type RankableNote,
} from './note-relevance';

const note = (over: Partial<RankableNote> & { id: string }): RankableNote => ({
  noteKey: over.id,
  title: null,
  content: '',
  keywords: [],
  explicitlyLinked: false,
  ...over,
});

describe('rankNotesForQuestion', () => {
  it('明確關聯的筆記排在最前面，不與關鍵字分數比較', () => {
    const ranked = rankNotesForQuestion(
      [
        note({ id: 'N1', content: '期貨交易稅期貨交易稅期貨交易稅', keywords: ['期貨交易稅'] }),
        note({ id: 'N2', content: '完全無關的內容', explicitlyLinked: true }),
      ],
      '臺指期貨的期貨交易稅稅率是多少',
    );
    expect(ranked[0]!.id).toBe('N2');
  });

  it('關鍵字命中的權重高於正文命中', () => {
    const ranked = rankNotesForQuestion(
      [
        note({ id: 'N1', content: '這裡提到期貨交易稅一次。' }),
        note({ id: 'N2', content: '無關內容。', keywords: ['期貨交易稅'] }),
      ],
      '期貨交易稅',
    );
    expect(ranked[0]!.id).toBe('N2');
  });

  it('完全沒有詞彙交集時分數為 0', () => {
    const ranked = rankNotesForQuestion(
      [note({ id: 'N1', content: '烹飪與園藝的入門介紹。' })],
      'ABCDEF',
    );
    expect(ranked[0]!.score).toBe(0);
  });

  it('**排序是全序：打亂輸入順序結果完全相同**', () => {
    // 少了 noteKey 收尾的平手判準，同分筆記會退回資料庫的回傳順序，
    // 而 PostgreSQL 不保證跨次一致 —— 快取指紋就會無故跳動。
    const notes = [
      note({ id: 'N3', noteKey: 'N3', content: '相同內容' }),
      note({ id: 'N1', noteKey: 'N1', content: '相同內容' }),
      note({ id: 'N2', noteKey: 'N2', content: '相同內容' }),
    ];
    const a = rankNotesForQuestion(notes, '相同內容').map((n) => n.noteKey);
    const b = rankNotesForQuestion([...notes].reverse(), '相同內容').map((n) => n.noteKey);
    expect(a).toEqual(b);
    expect(a).toEqual(['N1', 'N2', 'N3']);
  });

  it('長筆記不會單純因為篇幅而勝出', () => {
    // 正文只計「有沒有出現」，不計次數。
    const ranked = rankNotesForQuestion(
      [
        note({ id: 'N1', content: '期貨交易稅。'.repeat(200) }),
        note({ id: 'N2', content: '期貨交易稅', keywords: ['期貨交易稅'] }),
      ],
      '期貨交易稅',
    );
    expect(ranked[0]!.id).toBe('N2');
  });

  it('中文以 2-gram 比對，不需要斷詞器', () => {
    const ranked = rankNotesForQuestion(
      [note({ id: 'N1', content: '不動產證券化條例第49條規定 REITs 免徵證券交易稅。' })],
      '以下哪項新金融商品免徵交易稅？',
    );
    expect(ranked[0]!.score).toBeGreaterThan(0);
  });

  it('空的筆記清單不會爆炸', () => {
    expect(rankNotesForQuestion([], '任何題目')).toEqual([]);
  });
});

describe('selectNotesWithinBudget', () => {
  const ranked = (id: string, length: number) => ({
    ...note({ id, content: 'x'.repeat(length) }),
    score: 1,
  });

  it('逐段納入直到放不下為止', () => {
    const selected = selectNotesWithinBudget([ranked('N1', 60), ranked('N2', 60)], 100);
    expect(selected.map((n) => n.id)).toEqual(['N1']);
  });

  it('**放不下的筆記整段略過，不切半**', () => {
    // 切半的筆記在引用查核下特別麻煩：模型可能引用到被截掉的部分，
    // 於是一個合法的引用被判成捏造。
    const selected = selectNotesWithinBudget([ranked('N1', 60), ranked('N2', 60)], 100);
    expect(selected[0]!.content.length).toBe(60);
  });

  it('跳過放不下的之後，仍會納入後面塞得下的', () => {
    const selected = selectNotesWithinBudget(
      [ranked('N1', 60), ranked('N2', 90), ranked('N3', 30)],
      100,
    );
    expect(selected.map((n) => n.id)).toEqual(['N1', 'N3']);
  });

  it('第一段單獨就超過預算時截斷，否則這題會完全沒有筆記', () => {
    const selected = selectNotesWithinBudget([ranked('N1', 500)], 100);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.content.length).toBe(100);
  });

  it('空清單回傳空陣列', () => {
    expect(selectNotesWithinBudget([], 100)).toEqual([]);
  });
});
