import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ERROR_CODES, type Env, type UserResponse } from '@repo/contracts';
import type { CookieOptions, Response } from 'express';

import { AppException } from '../../common/app.exception';
import { CurrentUser, Public, type AuthenticatedRequest, type AuthenticatedUser } from '../../common/decorators';
import { ENV } from '../../config/env.config';
import { AuthService, type AuthSession } from './auth.service';
import {
  BootstrapDto,
  BootstrapStatusDto,
  CsrfTokenResponseDto,
  LoginDto,
  UserResponseDto,
} from './auth.dto';
import { CsrfService } from './csrf.service';
import {
  ACCESS_TOKEN_COOKIE,
  CSRF_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from './guards';
import { parseDuration } from './token.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly authService: AuthService,
    private readonly csrfService: CsrfService,
  ) {}

  @Public()
  @Get('bootstrap')
  @ApiOperation({
    summary: '查詢是否仍可初始化',
    description: '系統尚未建立任何帳號時回 true。建立後永久為 false。',
  })
  @ApiOkResponse({ type: BootstrapStatusDto })
  async bootstrapStatus(): Promise<{ canBootstrap: boolean }> {
    return { canBootstrap: await this.authService.canBootstrap() };
  }

  @Public()
  @Post('bootstrap')
  @ApiOperation({
    summary: '首次初始化：建立唯一帳號',
    description:
      '只在系統沒有任何帳號時可用。建立完成後此端點永久回 410 SETUP_ALREADY_COMPLETED。' +
      '密碼不需要、也不應該寫進 .env。',
  })
  @ApiOkResponse({ type: UserResponseDto })
  async bootstrap(
    @Body() dto: BootstrapDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserResponse> {
    const session = await this.authService.bootstrap(dto, this.requestMeta(req));
    this.setAuthCookies(res, session);
    return session.user;
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: '登入' })
  @ApiOkResponse({ type: UserResponseDto })
  async login(
    @Body() dto: LoginDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserResponse> {
    const session = await this.authService.login(dto, this.requestMeta(req));
    this.setAuthCookies(res, session);
    return session.user;
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: '輪替 refresh token',
    description: '舊 token 立即失效。若偵測到已撤銷的 token 被重複使用，會撤銷該使用者所有工作階段。',
  })
  @ApiOkResponse({ type: UserResponseDto })
  async refresh(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserResponse> {
    const token = this.readCookie(req, REFRESH_TOKEN_COOKIE);
    if (!token) {
      throw new AppException(ERROR_CODES.REFRESH_TOKEN_INVALID, '沒有可用的登入狀態。');
    }

    const session = await this.authService.refresh(token, this.requestMeta(req));
    this.setAuthCookies(res, session);
    return session.user;
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: '登出並撤銷 refresh token' })
  async logout(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    await this.authService.logout(this.readCookie(req, REFRESH_TOKEN_COOKIE));
    this.clearAuthCookies(res);
    return { ok: true };
  }

  @Get('me')
  @ApiOperation({ summary: '取得目前登入的使用者' })
  @ApiOkResponse({ type: UserResponseDto })
  me(@CurrentUser() user: AuthenticatedUser): Promise<UserResponse> {
    return this.authService.getUser(user.id);
  }

  @Public()
  @Get('csrf')
  @ApiOperation({
    summary: '取得 CSRF token',
    description:
      '回傳 token 本體，並將其 HMAC 寫入非 HttpOnly 的 csrf_token Cookie。' +
      '所有狀態變更請求都必須在 X-CSRF-Token 標頭帶上此 token。',
  })
  @ApiOkResponse({ type: CsrfTokenResponseDto })
  csrf(@Res({ passthrough: true }) res: Response): { csrfToken: string } {
    const { token, cookieValue } = this.csrfService.issueToken();

    res.cookie(CSRF_COOKIE, cookieValue, {
      // 刻意「不是」 HttpOnly：前端必須讀得到才能放進標頭。
      httpOnly: false,
      secure: this.env.AUTH_COOKIE_SECURE,
      sameSite: this.env.AUTH_COOKIE_SAMESITE,
      path: '/',
    });

    return { csrfToken: token };
  }

  // ------------------------------------------------------------- helpers

  private requestMeta(req: AuthenticatedRequest): { userAgent?: string; ip?: string } {
    return { userAgent: req.get('user-agent')?.slice(0, 300), ip: req.ip };
  }

  private readCookie(req: AuthenticatedRequest, name: string): string | undefined {
    return (req.cookies as Record<string, string> | undefined)?.[name];
  }

  private cookieBase(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.env.AUTH_COOKIE_SECURE,
      sameSite: this.env.AUTH_COOKIE_SAMESITE,
    };
  }

  /** refresh token 只在認證端點需要，限制路徑可縮小暴露面。 */
  private refreshCookiePath(): string {
    return `/${this.env.API_GLOBAL_PREFIX}/auth`.replace(/\/+/g, '/');
  }

  private setAuthCookies(res: Response, session: AuthSession): void {
    res.cookie(ACCESS_TOKEN_COOKIE, session.accessToken, {
      ...this.cookieBase(),
      path: '/',
      maxAge: parseDuration(this.env.JWT_ACCESS_TTL),
    });

    res.cookie(REFRESH_TOKEN_COOKIE, session.refresh.token, {
      ...this.cookieBase(),
      path: this.refreshCookiePath(),
      expires: session.refresh.expiresAt,
    });
  }

  private clearAuthCookies(res: Response): void {
    res.clearCookie(ACCESS_TOKEN_COOKIE, { ...this.cookieBase(), path: '/' });
    res.clearCookie(REFRESH_TOKEN_COOKIE, {
      ...this.cookieBase(),
      path: this.refreshCookiePath(),
    });
  }
}
