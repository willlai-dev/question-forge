import { describe, expect, it } from 'vitest';

import { findNextUnanswered } from './navigation';

/** `answered` 以字串表達：a = 已作答，'.' = 未作答。位置由 1 起算。 */
const build = (pattern: string) =>
  [...pattern].map((char, index) => ({ position: index + 1, answered: char === 'a' }));

describe('findNextUnanswered', () => {
  it('往後找到最近的未作答題', () => {
    expect(findNextUnanswered(build('aa.a.'), 1)).toBe(3);
  });

  it('**往後沒有時會繞回開頭**', () => {
    // 跳著作答時，漏掉的題目常常在前面——只往後找就永遠找不到它們，
    // 而那正是這個功能最該幫上忙的時候。
    expect(findNextUnanswered(build('.aaaa'), 3)).toBe(1);
  });

  it('**目前這一題即使未作答也不算**（否則按下去停在原地，像沒反應）', () => {
    expect(findNextUnanswered(build('a.a.a'), 2)).toBe(4);
  });

  it('全部作答完 → null', () => {
    expect(findNextUnanswered(build('aaaaa'), 2)).toBeNull();
  });

  it('只剩自己未作答 → null（不會回傳自己）', () => {
    expect(findNextUnanswered(build('a.aaa'), 2)).toBeNull();
  });

  it('一題都沒作答時從下一題開始', () => {
    expect(findNextUnanswered(build('.....'), 2)).toBe(3);
  });

  it('在最後一題時繞回最前面的未作答題', () => {
    expect(findNextUnanswered(build('.a.aa'), 5)).toBe(1);
  });

  it('輸入順序打亂也得到相同結果', () => {
    const questions = build('a.a.a');
    const shuffled = [questions[3]!, questions[0]!, questions[4]!, questions[2]!, questions[1]!];
    expect(findNextUnanswered(shuffled, 2)).toBe(4);
  });

  it('空清單不會爆炸', () => {
    expect(findNextUnanswered([], 1)).toBeNull();
  });

  it('位置超出範圍時仍能繞回開頭', () => {
    expect(findNextUnanswered(build('.a.'), 99)).toBe(1);
  });
});
