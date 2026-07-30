import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { RequestWithId } from './request-id.middleware';

/** 已通過認證的使用者（掛在 request 上）。 */
export interface AuthenticatedUser {
  id: string;
  username: string;
}

export interface AuthenticatedRequest extends RequestWithId {
  user?: AuthenticatedUser;
}

export const IS_PUBLIC_KEY = 'isPublic';
/** 標記端點免認證（登入、初始化、健康檢查等）。 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const SKIP_CSRF_KEY = 'skipCsrf';
/** 標記端點免 CSRF 檢查。僅用於本身就沒有 Cookie 可被利用的端點。 */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF_KEY, true);

/** 取出目前登入使用者。 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      // 正常情況下 JwtAuthGuard 會先擋下，走到這裡代表守衛設定有誤。
      throw new Error('CurrentUser 使用於未受保護的端點');
    }
    return request.user;
  },
);
