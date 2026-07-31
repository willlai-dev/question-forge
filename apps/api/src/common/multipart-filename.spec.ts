import { describe, expect, it } from 'vitest';

import { decodeMultipartFilename } from './multipart-filename';

/** 模擬 busboy 的行為：把 UTF-8 位元組當成 latin1 解讀。 */
const asBusboyWouldSend = (name: string) => Buffer.from(name, 'utf8').toString('latin1');

describe('decodeMultipartFilename', () => {
  it.each([
    '投資學-第一章.json',
    '投資學-第一章-選擇題.json',
    '行政法 112年地特.json',
    '題庫（含解析）.json',
    '日本語のファイル.json',
    'Español-preguntas.json',
  ])('還原被當成 latin1 的 UTF-8 檔名：%s', (original) => {
    expect(decodeMultipartFilename(asBusboyWouldSend(original))).toBe(original);
  });

  it('純 ASCII 檔名維持不變', () => {
    expect(decodeMultipartFilename('questions.json')).toBe('questions.json');
    expect(decodeMultipartFilename('2023-exam_v2.json')).toBe('2023-exam_v2.json');
  });

  it('已經正確解碼的中文檔名不會被二次破壞', () => {
    // 若日後 busboy 修正了預設值，直接傳入正確字串也必須安全。
    expect(decodeMultipartFilename('投資學-第一章.json')).toBe('投資學-第一章.json');
  });

  it('重複套用是冪等的', () => {
    const once = decodeMultipartFilename(asBusboyWouldSend('投資學-第一章.json'));
    expect(decodeMultipartFilename(once)).toBe(once);
  });

  it('本來就不是合法 UTF-8 的位元組序列，保留原樣不破壞', () => {
    // 0xFF 0xFE 不是合法的 UTF-8 起始位元組
    const invalid = 'ÿþý.json';
    expect(decodeMultipartFilename(invalid)).toBe(invalid);
  });

  it('空字串安全處理', () => {
    expect(decodeMultipartFilename('')).toBe('');
  });
});
