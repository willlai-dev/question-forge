import { describe, expect, it } from 'vitest';

import {
  computeAiJobIdempotencyKey,
  computeMistakeAnalysisCacheKey,
  computeUrlHash,
  normalizeUrl,
} from './cache-key';

const base = {
  questionId: '11111111-1111-4111-8111-111111111111',
  questionVersion: 1,
  selectedAnswers: ['B'],
  correctAnswers: ['A'],
  promptVersion: '1.0.0',
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
};

/**
 * 快取鍵決定「什麼時候可以不呼叫模型」。
 * 算錯的後果分兩種：太鬆會拿到過期的解析，太緊會白白燒掉免費額度。
 */
describe('computeMistakeAnalysisCacheKey', () => {
  it('相同輸入得到相同鍵', () => {
    expect(computeMistakeAnalysisCacheKey(base)).toBe(computeMistakeAnalysisCacheKey(base));
  });

  it('是 sha256 十六進位字串', () => {
    expect(computeMistakeAnalysisCacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['題目版本', { questionVersion: 2 }],
    ['使用者選的答案', { selectedAnswers: ['C'] }],
    ['正確答案', { correctAnswers: ['B'] }],
    ['prompt 版本', { promptVersion: '1.1.0' }],
    ['模型', { model: 'other/model' }],
  ])('%s 改變就會產生新的鍵（舊結果自然失效）', (_label, patch) => {
    expect(computeMistakeAnalysisCacheKey({ ...base, ...patch })).not.toBe(
      computeMistakeAnalysisCacheKey(base),
    );
  });

  it('答案順序不影響鍵（同一種錯法只分析一次）', () => {
    const a = computeMistakeAnalysisCacheKey({ ...base, selectedAnswers: ['A', 'C'] });
    const b = computeMistakeAnalysisCacheKey({ ...base, selectedAnswers: ['C', 'A'] });
    expect(a).toBe(b);
  });

  it('大小寫與空白不影響鍵', () => {
    const a = computeMistakeAnalysisCacheKey({ ...base, selectedAnswers: [' b '] });
    const b = computeMistakeAnalysisCacheKey({ ...base, selectedAnswers: ['B'] });
    expect(a).toBe(b);
  });

  it('不同題目不會撞鍵', () => {
    const other = { ...base, questionId: '22222222-2222-4222-8222-222222222222' };
    expect(computeMistakeAnalysisCacheKey(other)).not.toBe(computeMistakeAnalysisCacheKey(base));
  });
});

describe('computeAiJobIdempotencyKey', () => {
  const job = {
    userId: 'u1',
    jobType: 'question_analysis',
    questionId: 'q1',
    discriminator: 'hash:model:v1',
  };

  it('相同輸入得到相同鍵，重複送出不會排出第二個任務', () => {
    expect(computeAiJobIdempotencyKey(job)).toBe(computeAiJobIdempotencyKey(job));
  });

  it('判別內容改變就是新任務', () => {
    expect(computeAiJobIdempotencyKey({ ...job, discriminator: 'hash2:model:v1' })).not.toBe(
      computeAiJobIdempotencyKey(job),
    );
  });

  it('沒有題目 ID 也能安全產生', () => {
    expect(computeAiJobIdempotencyKey({ ...job, questionId: null })).toMatch(/^[0-9a-f]{48}$/);
  });
});

describe('normalizeUrl', () => {
  it('去掉 hash', () => {
    expect(normalizeUrl('https://a.com/p#section')).toBe('https://a.com/p');
  });

  it('網域轉小寫', () => {
    expect(normalizeUrl('https://A.COM/p')).toBe('https://a.com/p');
  });

  it('去掉預設埠', () => {
    expect(normalizeUrl('https://a.com:443/p')).toBe('https://a.com/p');
    expect(normalizeUrl('http://a.com:80/p')).toBe('http://a.com/p');
  });

  it('去掉結尾斜線', () => {
    expect(normalizeUrl('https://a.com/p/')).toBe('https://a.com/p');
  });

  it('移除追蹤參數但保留其他查詢字串', () => {
    expect(normalizeUrl('https://a.com/p?id=3&utm_source=x&fbclid=y')).toBe(
      'https://a.com/p?id=3',
    );
  });

  it('等價的寫法會收斂成同一個字串（避免重複擷取消耗額度）', () => {
    expect(normalizeUrl('https://A.com:443/page/?utm_medium=z#top')).toBe(
      normalizeUrl('https://a.com/page'),
    );
  });

  it('不合法的 URL 原樣回傳，不拋錯', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});

describe('computeUrlHash', () => {
  it('等價 URL 共用同一個快取鍵', () => {
    expect(computeUrlHash('https://A.com/p/#x')).toBe(computeUrlHash('https://a.com/p'));
  });

  it('不同 URL 不會撞鍵', () => {
    expect(computeUrlHash('https://a.com/p')).not.toBe(computeUrlHash('https://a.com/q'));
  });
});
