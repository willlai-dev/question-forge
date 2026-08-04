import { describe, expect, it } from 'vitest';

import { findNumericInconsistencies, formatPercent } from './numeric-consistency';

/**
 * 中文分數與百分比的一致性檢查。
 *
 * 取材自一次真實的錯誤解析（投資學・期貨交易稅）：模型寫出
 * 「稅率為契約金額的0.02%（10萬分之2）」——10萬分之2 是 0.002%，
 * 它在同一句話裡自我否定。答案選項本身是對的，錯的是支撐它的數字，
 * 而這種錯誤純算術就能判定，不需要任何外部知識。
 */
describe('findNumericInconsistencies', () => {
  it('抓出實際出錯的那一句：0.02% vs 10萬分之2', () => {
    const found = findNumericInconsistencies(
      '臺指期貨屬「股價指數期貨類」，依《期貨交易稅條例》課徵期貨交易稅，稅率為契約金額的0.02%（10萬分之2）。',
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.fraction).toBe('10萬分之2');
    expect(found[0]!.fractionAsPercent).toBeCloseTo(0.002, 10);
    expect(found[0]!.statedPercent).toBe(0.02);
  });

  it('正確的換算不會被誤判', () => {
    expect(findNumericInconsistencies('按契約金額課徵十萬分之2，即0.002%的期貨交易稅。')).toEqual([]);
    expect(findNumericInconsistencies('按權利金金額課徵千分之1，即0.1%的期貨交易稅。')).toEqual([]);
    expect(findNumericInconsistencies('稅率原則為千分之1（0.1%）。')).toEqual([]);
  });

  it('中文數字與阿拉伯數字兩種寫法都認得', () => {
    expect(findNumericInconsistencies('十萬分之二（0.002%）')).toEqual([]);
    expect(findNumericInconsistencies('10萬分之2（0.002%）')).toEqual([]);
    expect(findNumericInconsistencies('十萬分之二（0.02%）')).toHaveLength(1);
  });

  it('「十」單獨當單位時是 10，不是 0', () => {
    // 十分之一 = 10%。若把「十」解析成 0，這裡會除以零而漏掉檢查。
    expect(findNumericInconsistencies('十分之一（10%）')).toEqual([]);
    expect(findNumericInconsistencies('十分之一（1%）')).toHaveLength(1);
  });

  it('百分之N 也是分數的一種寫法', () => {
    expect(findNumericInconsistencies('百分之五（5%）')).toEqual([]);
    expect(findNumericInconsistencies('百分之五（50%）')).toHaveLength(1);
  });

  it('全形數字與全形百分號會先正規化', () => {
    expect(findNumericInconsistencies('千分之１（０.１％）')).toEqual([]);
  });

  // --- 誤殺防線 ---
  //
  // 這幾條比「抓得到」更重要：誤殺會讓合法的解析反覆重生直到失敗，
  // 使用者看到的是整次分析壞掉，比看到一個錯誤數字更糟。

  it('各自獨立的數字不會被硬湊成一對', () => {
    expect(
      findNumericInconsistencies('股票稅率是千分之3、公司債是千分之1，兩者合計約0.4%。'),
    ).toEqual([]);
  });

  it('中間隔著實詞就不算同位語', () => {
    expect(findNumericInconsistencies('千分之1 這個級距的適用範圍涵蓋約 60% 的交易。')).toEqual([]);
  });

  it('四捨五入的近似值不會被判成矛盾', () => {
    expect(findNumericInconsistencies('三分之一（約33%）')).toEqual([]);
    expect(findNumericInconsistencies('三分之一（約33.3%）')).toEqual([]);
  });

  it('一個分數旁同時有對得上與對不上的百分比時，以對得上的為準', () => {
    // 「千分之1（0.1%）」是同位語，後面的 5% 是另一件事。
    expect(findNumericInconsistencies('千分之1（0.1%），另有5%的附加稅。')).toEqual([]);
  });

  it('沒有百分比就不會有輸出', () => {
    expect(findNumericInconsistencies('依十萬分之二課徵期貨交易稅。')).toEqual([]);
  });

  it('分母為零或無法解析時安靜略過，不丟例外', () => {
    expect(() => findNumericInconsistencies('零分之一（50%）')).not.toThrow();
    expect(findNumericInconsistencies('零分之一（50%）')).toEqual([]);
    expect(findNumericInconsistencies('甲分之乙（50%）')).toEqual([]);
  });

  it('空字串與純文字不會有輸出', () => {
    expect(findNumericInconsistencies('')).toEqual([]);
    expect(findNumericInconsistencies('本題考查交易稅的課徵規定。')).toEqual([]);
  });

  it('同一段文字裡的多處矛盾會全部回報', () => {
    const found = findNumericInconsistencies('甲為千分之1（1%）；乙為百分之2（0.2%）。');
    expect(found).toHaveLength(2);
  });
});

describe('formatPercent', () => {
  it('去掉浮點運算的尾數雜訊', () => {
    expect(formatPercent((2 / 100_000) * 100)).toBe('0.002');
    expect(formatPercent((1 / 3) * 100)).toBe('33.3333');
    expect(formatPercent(0.1)).toBe('0.1');
  });
});
