import type { ApiError } from '@repo/contracts';

/**
 * 後端 API 呼叫封裝。
 *
 * 設計重點：
 *   - 只使用 NEXT_PUBLIC_API_URL，前端永遠拿不到任何後端機密。
 *   - credentials: 'include' 讓 HttpOnly Cookie 能跟著送出。
 *   - 狀態變更請求自動附上 CSRF token（第一次需要時才去取，之後快取）。
 *   - 統一解析後端錯誤格式，讓上層只需處理 ApiRequestError。
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: ApiError['error']['details'],
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** 取出某個欄位的驗證訊息，供表單顯示。 */
  fieldError(path: string): string | undefined {
    return this.details?.find((d) => d.path === path)?.message;
  }
}

/**
 * CSRF token 管理。
 *
 * 重點：後端每次呼叫 GET /auth/csrf 都會產生新 token 並覆寫 csrf_token cookie，
 * 使先前取得的 token 立刻失效。因此全前端「只能有一個地方」去取 token ——
 * 任何額外的直接呼叫都會讓這裡快取的值變成過期，造成後續請求 403。
 * 需要 token 的地方（例如 multipart 上傳）一律使用 getCsrfToken()。
 */
let csrfToken: string | null = null;
let inFlight: Promise<string> | null = null;

export async function getCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;

  // 併發請求共用同一次取得，避免互相覆寫 cookie。
  inFlight ??= (async () => {
    const res = await fetch(`${API_BASE_URL}/auth/csrf`, { credentials: 'include' });
    if (!res.ok) {
      throw new ApiRequestError(res.status, 'CSRF_FETCH_FAILED', '無法取得 CSRF token。');
    }
    const data = (await res.json()) as { csrfToken: string };
    csrfToken = data.csrfToken;
    return csrfToken;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/** 登出或 CSRF 失效時呼叫，強制下次重新取得。 */
export function resetCsrfToken(): void {
  csrfToken = null;
}

/**
 * Access token 過期時的自動續期。
 *
 * 背景：access token 只有 15 分鐘，refresh token 有 30 天。作答一份 20 題的考卷
 * 很容易超過 15 分鐘，若不續期，使用者會在作答到一半時被踢回登入頁。
 *
 * **必須去重**：後端的 refresh 採 token 輪替並且會偵測重放 ——
 * 若多個並行請求各自拿「同一個舊 token」去換新的，第二個之後都會被判定為重放攻擊，
 * 後端會撤銷該使用者的**所有**工作階段。因此同一時間只能有一次續期在飛。
 */
let refreshInFlight: Promise<boolean> | null = null;

/** 這些端點的 401 是真的沒登入，不該再去續期（尤其 /auth/refresh 自己）。 */
const NO_REFRESH_PATHS = ['/auth/refresh', '/auth/login', '/auth/logout', '/auth/bootstrap'];

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': await getCsrfToken() },
      });
      return response.ok;
    } catch {
      // 網路層失敗不該被誤判成「登入已失效」，交由原本的錯誤往上拋。
      return false;
    }
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

export interface ApiFetchOptions extends Omit<RequestInit, 'body' | 'method'> {
  method?: string;
  body?: unknown;
}

/**
 * 已經用掉的自我修復手段。
 *
 * 兩種恢復各只允許一次，因此一個請求最多重送兩次；
 * 用旗標而不是單一個 boolean，是為了讓「CSRF 過期」與「登入過期」同時發生時
 * 兩者都能各自恢復，同時仍然有明確的上限，不會無限重試。
 */
interface RecoveryState {
  csrf: boolean;
  auth: boolean;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  return sendRequest<T>(path, options, { csrf: false, auth: false });
}

async function sendRequest<T>(
  path: string,
  options: ApiFetchOptions,
  recovered: RecoveryState,
): Promise<T> {
  const { body, headers, method = 'GET', ...rest } = options;

  const finalHeaders: Record<string, string> = {
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(headers as Record<string, string> | undefined),
  };

  if (MUTATING_METHODS.has(method.toUpperCase())) {
    finalHeaders['X-CSRF-Token'] = await getCsrfToken();
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    method,
    credentials: 'include',
    headers: finalHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const error = (payload as ApiError | undefined)?.error;

    // CSRF token 過期是可自行修復的狀況（例如 cookie 被另一次取得覆寫），
    // 重新取得後重試一次即可，不需要讓使用者看到錯誤或手動重新整理。
    if (error?.code === 'CSRF_TOKEN_INVALID' && !recovered.csrf) {
      resetCsrfToken();
      return sendRequest<T>(path, options, { ...recovered, csrf: true });
    }

    if (error?.code === 'CSRF_TOKEN_INVALID') resetCsrfToken();

    // Access token 過期同樣可以自行修復：用 refresh token 換一組新的再重送。
    // 續期失敗才把原本的 401 拋出去，由 AppShell 導向登入頁。
    if (response.status === 401 && !recovered.auth && !NO_REFRESH_PATHS.includes(path)) {
      if (await refreshSession()) {
        return sendRequest<T>(path, options, { ...recovered, auth: true });
      }
    }

    throw new ApiRequestError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? `請求失敗（HTTP ${response.status}）`,
      error?.details,
      error?.requestId,
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};
