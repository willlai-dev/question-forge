import type { Env } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { CsrfService } from './csrf.service';

const service = new CsrfService({ CSRF_SECRET: 'test-csrf-secret-value' } as Env);
const other = new CsrfService({ CSRF_SECRET: 'a-completely-different-secret' } as Env);

describe('CsrfService', () => {
  it('簽發的 token 可以通過驗證', () => {
    const { token, cookieValue } = service.issueToken();
    expect(service.verify(token, cookieValue)).toBe(true);
  });

  it('每次簽發的 token 都不同', () => {
    expect(service.issueToken().token).not.toBe(service.issueToken().token);
  });

  it('缺少標頭時驗證失敗', () => {
    const { cookieValue } = service.issueToken();
    expect(service.verify(undefined, cookieValue)).toBe(false);
  });

  it('缺少 cookie 時驗證失敗', () => {
    const { token } = service.issueToken();
    expect(service.verify(token, undefined)).toBe(false);
  });

  it('標頭與 cookie 不成對時驗證失敗', () => {
    const a = service.issueToken();
    const b = service.issueToken();
    expect(service.verify(a.token, b.cookieValue)).toBe(false);
  });

  it('攻擊者無法自行偽造 cookie 值（不知道 secret）', () => {
    const { token } = service.issueToken();
    const forged = other.issueToken().cookieValue;
    expect(service.verify(token, forged)).toBe(false);
  });

  it('cookie 中存的是簽章而非 token 本身', () => {
    const { token, cookieValue } = service.issueToken();
    expect(cookieValue).not.toBe(token);
  });

  it('長度不同的值不會拋出例外（timingSafeEqual 前已檢查長度）', () => {
    const { token } = service.issueToken();
    expect(() => service.verify(token, 'short')).not.toThrow();
    expect(service.verify(token, 'short')).toBe(false);
  });
});
