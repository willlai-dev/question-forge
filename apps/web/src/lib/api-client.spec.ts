import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiRequestError, getCsrfToken, resetCsrfToken } from './api-client';

/**
 * 這些測試鎖住 CSRF token 的取得與重試行為。
 *
 * 背景：後端每次 GET /auth/csrf 都會產生新 token 並覆寫 cookie，
 * 使先前的 token 立刻失效。因此前端必須只有一個取得來源，
 * 且遇到 token 過期時要能自行恢復，而不是把錯誤丟給使用者。
 */

const BASE = 'http://localhost:4000/api/v1';

interface Call {
  url: string;
  method: string;
  csrfHeader?: string;
}

let calls: Call[] = [];
let tokenCounter = 0;
/** 伺服器端目前有效的 token（模擬 cookie 中的 HMAC）。 */
let serverToken = '';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  calls = [];
  tokenCounter = 0;
  serverToken = '';
  resetCsrfToken();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method, csrfHeader: headers['X-CSRF-Token'] });

      if (url === `${BASE}/auth/csrf`) {
        // 每次取得都會輪替，舊 token 立即失效 —— 與真實後端行為一致。
        tokenCounter += 1;
        serverToken = `token-${tokenCounter}`;
        return jsonResponse(200, { csrfToken: serverToken });
      }

      if (method !== 'GET') {
        if (headers['X-CSRF-Token'] !== serverToken) {
          return jsonResponse(403, {
            error: { code: 'CSRF_TOKEN_INVALID', message: 'CSRF 驗證失敗', requestId: 'r', timestamp: '' },
          });
        }
        return jsonResponse(200, { ok: true });
      }

      return jsonResponse(200, { data: 'ok' });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCsrfToken();
});

describe('getCsrfToken', () => {
  it('第一次取得後會快取，不重複呼叫後端', async () => {
    const first = await getCsrfToken();
    const second = await getCsrfToken();

    expect(first).toBe(second);
    expect(calls.filter((c) => c.url.endsWith('/auth/csrf'))).toHaveLength(1);
  });

  it('併發取得只會發出一次請求（避免互相覆寫 cookie）', async () => {
    const [a, b, c] = await Promise.all([getCsrfToken(), getCsrfToken(), getCsrfToken()]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(calls.filter((x) => x.url.endsWith('/auth/csrf'))).toHaveLength(1);
  });

  it('reset 之後會重新取得', async () => {
    const first = await getCsrfToken();
    resetCsrfToken();
    const second = await getCsrfToken();

    expect(second).not.toBe(first);
    expect(calls.filter((c) => c.url.endsWith('/auth/csrf'))).toHaveLength(2);
  });
});

describe('狀態變更請求的 CSRF 處理', () => {
  it('POST 會自動帶上 X-CSRF-Token', async () => {
    await api.post('/subjects', { name: '行政法' });

    const post = calls.find((c) => c.method === 'POST');
    expect(post?.csrfHeader).toBeTruthy();
  });

  it('GET 不會帶 CSRF 標頭', async () => {
    await api.get('/subjects');

    const get = calls.find((c) => c.url.endsWith('/subjects') && c.method === 'GET');
    expect(get?.csrfHeader).toBeUndefined();
  });

  it('token 過期時自動重取並重試一次，呼叫端不會看到錯誤', async () => {
    // 先取得 token，接著讓伺服器端輪替，使快取的 token 失效
    await getCsrfToken();
    await fetch(`${BASE}/auth/csrf`); // 模擬別處直接呼叫造成的輪替

    const result = await api.post('/subjects', { name: '行政法' });

    expect(result).toEqual({ ok: true });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2); // 第一次 403、重取後第二次成功
    expect(posts[0]!.csrfHeader).not.toBe(posts[1]!.csrfHeader);
  });

  it('重試後仍失敗時只重試一次，並把錯誤拋給呼叫端', async () => {
    // 讓伺服器永遠不接受任何 token
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method });
        if (url.endsWith('/auth/csrf')) return jsonResponse(200, { csrfToken: 'whatever' });
        return jsonResponse(403, {
          error: { code: 'CSRF_TOKEN_INVALID', message: 'CSRF 驗證失敗', requestId: 'r', timestamp: '' },
        });
      }),
    );

    await expect(api.post('/subjects', { name: 'x' })).rejects.toBeInstanceOf(ApiRequestError);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });
});
