import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES, type Env } from '@repo/contracts';

import { AppException } from '../../common/app.exception';
import {
  IS_PUBLIC_KEY,
  SKIP_CSRF_KEY,
  type AuthenticatedRequest,
} from '../../common/decorators';
import { ENV } from '../../config/env.config';
import { CsrfService } from './csrf.service';
import { TokenService } from './token.service';

export const ACCESS_TOKEN_COOKIE = 'access_token';
export const REFRESH_TOKEN_COOKIE = 'refresh_token';
export const CSRF_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'x-csrf-token';

function isPublic(reflector: Reflector, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? false
  );
}

/**
 * 認證守衛：從 HttpOnly Cookie 取出 access token 並驗證。
 *
 * 刻意不接受 Authorization 標頭 —— 本系統的 token 只透過 Cookie 傳遞，
 * 少一個傳遞管道就少一種被誤用的方式。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (isPublic(this.reflector, context)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = (request.cookies as Record<string, string> | undefined)?.[ACCESS_TOKEN_COOKIE];

    if (!token) {
      throw new AppException(ERROR_CODES.UNAUTHORIZED, '尚未登入。');
    }

    const payload = this.tokenService.verifyAccessToken(token);
    if (!payload) {
      throw new AppException(ERROR_CODES.UNAUTHORIZED, '登入狀態已過期，請重新整理或重新登入。');
    }

    request.user = { id: payload.sub, username: payload.username };
    return true;
  }
}

/**
 * CSRF 守衛：檢查狀態變更請求的 double-submit token 與 Origin。
 *
 * 前後端同為 localhost 只是連接埠不同，屬 same-site，
 * 瀏覽器會在跨埠請求帶上 Cookie，因此 CSRF 防護不可省略。
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

  constructor(
    private readonly reflector: Reflector,
    private readonly csrfService: CsrfService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (this.safeMethods.has(request.method)) return true;

    const skip =
      this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;
    if (skip) return true;

    // Origin 檢查：跨站請求一律拒絕。
    const origin = request.get('origin');
    if (origin) {
      const allowed = this.env.CORS_ORIGIN.split(',').map((o) => o.trim());
      if (!allowed.includes(origin)) {
        throw new AppException(ERROR_CODES.CSRF_TOKEN_INVALID, '請求來源不被允許。');
      }
    }

    const headerToken = request.get(CSRF_HEADER);
    const cookieValue = (request.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];

    if (!this.csrfService.verify(headerToken, cookieValue)) {
      throw new AppException(
        ERROR_CODES.CSRF_TOKEN_INVALID,
        'CSRF 驗證失敗，請重新整理頁面後再試。',
      );
    }

    return true;
  }
}
