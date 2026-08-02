import { describe, expect, it } from 'vitest';

import { percent } from './percent';

describe('percent', () => {
  it('分母為 0 時回傳 null 而非 0', () => {
    // 「沒作答」與「全部答錯」不能是同一個數字。
    expect(percent(0, 0)).toBeNull();
  });

  it('分母為負數也回傳 null', () => {
    expect(percent(1, -1)).toBeNull();
  });

  it('全部答對是 100', () => {
    expect(percent(3, 3)).toBe(100);
  });

  it('全部答錯是 0，而不是 null', () => {
    expect(percent(0, 5)).toBe(0);
  });

  it('取到小數點後兩位', () => {
    expect(percent(1, 3)).toBe(33.33);
    expect(percent(2, 3)).toBe(66.67);
  });
});
