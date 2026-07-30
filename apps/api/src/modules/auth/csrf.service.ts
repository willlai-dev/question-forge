import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@repo/contracts';

import { ENV } from '../../config/env.config';

/**
 * CSRF 防護：double-submit cookie + HMAC。
 *
 * 流程：
 *   1. GET /auth/csrf 產生隨機 token，回傳 token 本體給前端，
 *      同時把 HMAC(secret, token) 寫入「非 HttpOnly」的 csrf_token cookie。
 *   2. 前端把 token 放在 X-CSRF-Token 標頭送出。
 *   3. 伺服器比對 HMAC(secret, 標頭值) 是否等於 cookie 值。
 *
 * 為什麼有效：跨站頁面雖然能讓瀏覽器自動帶上 cookie，
 * 但受同源政策限制「讀不到」cookie 內容，因此無法組出正確的標頭。
 */
@Injectable()
export class CsrfService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  issueToken(): { token: string; cookieValue: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, cookieValue: this.sign(token) };
  }

  verify(headerToken: string | undefined, cookieValue: string | undefined): boolean {
    if (!headerToken || !cookieValue) return false;

    const expected = Buffer.from(this.sign(headerToken));
    const actual = Buffer.from(cookieValue);
    if (expected.length !== actual.length) return false;

    return timingSafeEqual(expected, actual);
  }

  private sign(token: string): string {
    return createHmac('sha256', this.env.CSRF_SECRET).update(token).digest('base64url');
  }
}
