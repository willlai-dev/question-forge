import { describe, expect, it } from 'vitest';

import { isSameTagName, normalizeTagName, toTagSlug } from './normalize';
import { ERROR_TYPE_SEEDS, SKILL_TAG_SEEDS } from './seed-data';

/**
 * 正規化是「標籤不得失控」的第一道防線（規格 §8）。
 * 它決定了兩個名稱算不算同一個標籤，因此每一條規則都要能被指出來。
 */

describe('normalizeTagName', () => {
  it('去掉前後空白', () => {
    expect(normalizeTagName('  行政處分  ')).toBe('行政處分');
  });

  it('去掉中間的空白（中文詞彙的空白不帶語意）', () => {
    expect(normalizeTagName('行政 處分')).toBe('行政處分');
    expect(normalizeTagName('行政　處分')).toBe('行政處分'); // 全形空白
  });

  it('英文轉小寫', () => {
    expect(normalizeTagName('ROE')).toBe('roe');
    expect(normalizeTagName('RoE')).toBe('roe');
  });

  it('全形英數轉半形', () => {
    expect(normalizeTagName('ＲＯＥ')).toBe('roe');
    expect(normalizeTagName('１２３')).toBe('123');
  });

  it('全形括號轉半形', () => {
    expect(normalizeTagName('行政處分（廣義）')).toBe('行政處分(廣義)');
    expect(normalizeTagName('行政處分(廣義)')).toBe('行政處分(廣義)');
  });

  it('全形與半形寫法會收斂成同一個鍵', () => {
    expect(normalizeTagName('ＲＯＥ 分析')).toBe(normalizeTagName('roe分析'));
  });

  it('是冪等的', () => {
    const once = normalizeTagName(' ＲＯＥ　分析 ');
    expect(normalizeTagName(once)).toBe(once);
  });

  it('不同的標籤不會被誤收斂', () => {
    expect(normalizeTagName('行政處分')).not.toBe(normalizeTagName('行政契約'));
  });

  it('錯字不會被自動修正（那是別名的工作，不是正規化的）', () => {
    // 「處份」是錯字。正規化若試圖猜測使用者意圖，就會製造更難查的錯誤；
    // 這種對應必須由 tag_aliases 明確登錄。
    expect(normalizeTagName('行政處份')).not.toBe(normalizeTagName('行政處分'));
  });

  it('空字串安全處理', () => {
    expect(normalizeTagName('')).toBe('');
    expect(normalizeTagName('   ')).toBe('');
  });
});

describe('toTagSlug', () => {
  it('與 normalizeTagName 使用同一套規則', () => {
    // 兩者若各自演進，就會出現「別名比對得到 A，但唯一索引擋的是 B」這種難以理解的狀況。
    for (const name of ['行政處分', 'ＲＯＥ 分析', '  Due  Process  ']) {
      expect(toTagSlug(name)).toBe(normalizeTagName(name));
    }
  });
});

describe('isSameTagName', () => {
  it.each([
    ['行政處分', '行政 處分'],
    ['ROE', 'ｒｏｅ'],
    ['財務報表分析', '財務報表分析'],
  ])('%s 與 %s 視為同一個標籤', (a, b) => {
    expect(isSameTagName(a, b)).toBe(true);
  });

  it.each([
    ['行政處分', '行政處份'],
    ['行政處分', '行政契約'],
  ])('%s 與 %s 不是同一個標籤', (a, b) => {
    expect(isSameTagName(a, b)).toBe(false);
  });
});

describe('種子資料', () => {
  it('能力類型剛好 6 種（FR-TAG-04）', () => {
    expect(SKILL_TAG_SEEDS).toHaveLength(6);
  });

  it('錯誤類型剛好 8 種（FR-TAG-05）', () => {
    expect(ERROR_TYPE_SEEDS).toHaveLength(8);
  });

  it('錯誤類型有且只有一個 fallback', () => {
    // 沒有 fallback，AI 判斷不出錯因時會被迫亂猜一個具體錯誤；
    // 有兩個以上，「判斷不出來時該選哪個」就沒有唯一答案。
    const fallbacks = ERROR_TYPE_SEEDS.filter((seed) => seed.isFallback);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.name).toBe('無法判定');
  });

  it('種子的 slug 與 code 正規化後都不重複', () => {
    const skillSlugs = SKILL_TAG_SEEDS.map((seed) => toTagSlug(seed.slug));
    expect(new Set(skillSlugs).size).toBe(skillSlugs.length);

    const codes = ERROR_TYPE_SEEDS.map((seed) => seed.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('每一項都有說明文字（供 AI prompt 與使用者理解用）', () => {
    for (const seed of [...SKILL_TAG_SEEDS, ...ERROR_TYPE_SEEDS]) {
      expect(seed.description.length).toBeGreaterThan(0);
    }
  });
});
