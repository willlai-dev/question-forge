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

let csrfToken: string | null = null;

async function ensureCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  const res = await fetch(`${API_BASE_URL}/auth/csrf`, { credentials: 'include' });
  if (!res.ok) throw new ApiRequestError(res.status, 'CSRF_FETCH_FAILED', '無法取得 CSRF token。');
  const data = (await res.json()) as { csrfToken: string };
  csrfToken = data.csrfToken;
  return csrfToken;
}

/** 登出或 CSRF 失效時呼叫，強制下次重新取得。 */
export function resetCsrfToken(): void {
  csrfToken = null;
}

export interface ApiFetchOptions extends Omit<RequestInit, 'body' | 'method'> {
  method?: string;
  body?: unknown;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { body, headers, method = 'GET', ...rest } = options;

  const finalHeaders: Record<string, string> = {
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(headers as Record<string, string> | undefined),
  };

  if (MUTATING_METHODS.has(method.toUpperCase())) {
    finalHeaders['X-CSRF-Token'] = await ensureCsrfToken();
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

    // CSRF token 失效時清掉快取，讓下次請求重新取得。
    if (error?.code === 'CSRF_TOKEN_INVALID') resetCsrfToken();

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
  patch: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};
