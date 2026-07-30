import type { ApiError } from '@repo/contracts';

/**
 * 後端 API 呼叫封裝。
 *
 * 設計重點：
 *   - 只使用 NEXT_PUBLIC_API_URL，前端永遠拿不到任何後端機密。
 *   - credentials: 'include' 讓 HttpOnly Cookie 能跟著送出（認證機制）。
 *   - 統一解析後端的錯誤格式，讓上層只需要處理 ApiRequestError。
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

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
}

export interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** 狀態變更請求需附上 CSRF token（Phase 1 認證完成後啟用）。 */
  csrfToken?: string;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { body, csrfToken, headers, ...rest } = options;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const error = (payload as ApiError | undefined)?.error;
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
