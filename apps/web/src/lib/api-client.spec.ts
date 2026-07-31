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

/**
 * Access token 只有 15 分鐘，refresh token 有 30 天。
 * 作答一份 20 題的考卷很容易超過 15 分鐘，若不自動續期，
 * 使用者會在作答到一半時被踢回登入頁 —— 這組測試鎖住續期行為。
 */
describe('access token 自動續期', () => {
  /** 建立一個「前 N 次呼叫業務端點回 401，續期成功後改回 200」的伺服器。 */
  function stubServer(options: { refreshOk: boolean }) {
    let refreshed = false;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method });

        if (url.endsWith('/auth/csrf')) return jsonResponse(200, { csrfToken: 'csrf-1' });

        if (url.endsWith('/auth/refresh')) {
          if (!options.refreshOk) {
            return jsonResponse(401, {
              error: { code: 'REFRESH_TOKEN_INVALID', message: '登入已失效', requestId: 'r', timestamp: '' },
            });
          }
          refreshed = true;
          return jsonResponse(200, { username: 'probe' });
        }

        if (!refreshed) {
          return jsonResponse(401, {
            error: { code: 'UNAUTHORIZED', message: '尚未登入。', requestId: 'r', timestamp: '' },
          });
        }
        return jsonResponse(200, { ok: true });
      }),
    );
  }

  const refreshCalls = () => calls.filter((c) => c.url.endsWith('/auth/refresh'));

  it('401 時自動續期並重送，呼叫端不會看到錯誤', async () => {
    stubServer({ refreshOk: true });

    await expect(api.get('/quiz-sessions/abc')).resolves.toEqual({ ok: true });
    expect(refreshCalls()).toHaveLength(1);
  });

  it('狀態變更請求也會續期後重送', async () => {
    stubServer({ refreshOk: true });

    await expect(api.post('/quiz-sessions/abc/answers', { selectedAnswers: ['B'] })).resolves.toEqual({
      ok: true,
    });
    expect(refreshCalls()).toHaveLength(1);
  });

  it('多個請求同時遇到 401，只會續期一次', async () => {
    // 這一條最重要：後端的 refresh 採 token 輪替並偵測重放，
    // 若並行請求各自拿同一個舊 token 去換，第二個之後會被判定為重放，
    // 後端會撤銷該使用者的所有工作階段 —— 使用者會突然被登出。
    stubServer({ refreshOk: true });

    const results = await Promise.all([
      api.get('/quiz-sessions/a'),
      api.get('/quiz-sessions/b'),
      api.get('/quiz-sessions/c'),
    ]);

    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(refreshCalls()).toHaveLength(1);
  });

  it('續期失敗時拋出原本的 401，讓上層導向登入頁', async () => {
    stubServer({ refreshOk: false });

    await expect(api.get('/quiz-sessions/abc')).rejects.toMatchObject({ status: 401 });
    expect(refreshCalls()).toHaveLength(1);
  });

  it('只續期一次，不會無限重試', async () => {
    // 續期回 200 但業務端點仍持續 401（例如帳號被停用）
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET' });
        if (url.endsWith('/auth/csrf')) return jsonResponse(200, { csrfToken: 'csrf-1' });
        if (url.endsWith('/auth/refresh')) return jsonResponse(200, { username: 'probe' });
        return jsonResponse(401, {
          error: { code: 'UNAUTHORIZED', message: '尚未登入。', requestId: 'r', timestamp: '' },
        });
      }),
    );

    await expect(api.get('/quiz-sessions/abc')).rejects.toMatchObject({ status: 401 });
    expect(refreshCalls()).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith('/quiz-sessions/abc'))).toHaveLength(2);
  });

  it.each([
    ['/auth/login', 0],
    ['/auth/logout', 0],
    ['/auth/bootstrap', 0],
    // 直接呼叫續期端點本身也算一次，重點是不會因為它的 401 再遞迴續期一次。
    ['/auth/refresh', 1],
  ])('%s 的 401 不會觸發續期（那是真的沒登入）', async (path, expectedRefreshCalls) => {
    // 全部端點都回 401，若有多餘的續期嘗試就會被計數抓到。
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET' });
        if (url.endsWith('/auth/csrf')) return jsonResponse(200, { csrfToken: 'csrf-1' });
        return jsonResponse(401, {
          error: { code: 'UNAUTHORIZED', message: '尚未登入。', requestId: 'r', timestamp: '' },
        });
      }),
    );

    await expect(api.post(path as string, {})).rejects.toMatchObject({ status: 401 });
    expect(refreshCalls()).toHaveLength(expectedRefreshCalls as number);
  });

  it('未過期時完全不會呼叫續期端點', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET' });
        if (url.endsWith('/auth/csrf')) return jsonResponse(200, { csrfToken: 'csrf-1' });
        return jsonResponse(200, { ok: true });
      }),
    );

    await api.get('/quiz-sessions/abc');
    expect(refreshCalls()).toHaveLength(0);
  });
});
