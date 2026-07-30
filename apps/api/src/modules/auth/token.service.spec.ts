import { describe, expect, it } from 'vitest';

import { parseDuration } from './token.service';

describe('parseDuration', () => {
  it.each([
    ['15m', 15 * 60_000],
    ['30d', 30 * 86_400_000],
    ['1h', 3_600_000],
    ['45s', 45_000],
    ['500ms', 500],
    ['  7d  ', 7 * 86_400_000],
  ])('把 %s 轉成 %d 毫秒', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each(['', '15', 'm', '15 minutes', '-5m', '1.5h', 'abc'])(
    '拒絕無法解析的值：%s',
    (input) => {
      expect(() => parseDuration(input)).toThrow();
    },
  );
});
