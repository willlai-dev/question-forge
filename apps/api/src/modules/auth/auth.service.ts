import { Inject, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  type BootstrapRequest,
  type LoginRequest,
  type UserResponse,
} from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { eq, sql } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { DATABASE } from '../../infra/infra.module';
import { PasswordService } from './password.service';
import { TokenService, type IssuedRefreshToken } from './token.service';

/** app_settings 中代表「初始化已完成」的鍵。 */
export const SETUP_COMPLETED_KEY = 'setup.completed';

export interface AuthSession {
  user: UserResponse;
  accessToken: string;
  refresh: IssuedRefreshToken;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
  ) {}

  /** 是否仍可執行首次初始化。 */
  async canBootstrap(): Promise<boolean> {
    const { db } = this.database;

    const [setting] = await db
      .select({ key: schema.appSettings.key })
      .from(schema.appSettings)
      .where(eq(schema.appSettings.key, SETUP_COMPLETED_KEY))
      .limit(1);
    if (setting) return false;

    const countRows = await db.select({ count: sql<number>`count(*)::int` }).from(schema.users);
    return (countRows[0]?.count ?? 0) === 0;
  }

  /**
   * 首次初始化：建立唯一使用者。
   *
   * 整個流程在單一交易內完成，並以 app_settings 的主鍵作為併發保護 ——
   * 兩個同時抵達的初始化請求，第二個會因主鍵衝突而失敗，不可能建立出第二個帳號。
   */
  async bootstrap(
    dto: BootstrapRequest,
    meta: { userAgent?: string; ip?: string },
  ): Promise<AuthSession> {
    const passwordHash = await this.passwordService.hash(dto.password);

    const user = await this.database.db.transaction(async (tx) => {
      const countRows = await tx.select({ count: sql<number>`count(*)::int` }).from(schema.users);
      if ((countRows[0]?.count ?? 0) > 0) {
        throw new AppException(
          ERROR_CODES.SETUP_ALREADY_COMPLETED,
          '系統已完成初始化，初始化頁面已停用。',
        );
      }

      const [created] = await tx
        .insert(schema.users)
        .values({
          username: dto.username,
          displayName: dto.displayName ?? null,
          passwordHash,
        })
        .returning();

      await tx.insert(schema.appSettings).values({
        key: SETUP_COMPLETED_KEY,
        value: { completedAt: new Date().toISOString(), userId: created!.id },
      });

      return created!;
    });

    return this.createSession(user, meta);
  }

  async login(dto: LoginRequest, meta: { userAgent?: string; ip?: string }): Promise<AuthSession> {
    const { db } = this.database;

    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, dto.username))
      .limit(1);

    // 帳號不存在時仍執行一次雜湊驗證，讓「帳號不存在」與「密碼錯誤」的
    // 回應時間相近，避免以時間差枚舉帳號。
    const passwordHash =
      user?.passwordHash ??
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000';
    const valid = await this.passwordService.verify(passwordHash, dto.password);

    if (!user || !valid) {
      throw new AppException(ERROR_CODES.INVALID_CREDENTIALS, '帳號或密碼錯誤。');
    }

    await db
      .update(schema.users)
      .set({ lastLoginAt: new Date() })
      .where(eq(schema.users.id, user.id));

    return this.createSession({ ...user, lastLoginAt: new Date() }, meta);
  }

  async refresh(rawToken: string, meta: { userAgent?: string; ip?: string }): Promise<AuthSession> {
    const { userId, refresh } = await this.tokenService.rotateRefreshToken(rawToken, meta);

    const [user] = await this.database.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!user) {
      throw new AppException(ERROR_CODES.REFRESH_TOKEN_INVALID, '登入狀態已失效，請重新登入。');
    }

    return {
      user: toUserResponse(user),
      accessToken: this.tokenService.signAccessToken({ sub: user.id, username: user.username }),
      refresh,
    };
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (rawToken) await this.tokenService.revokeRefreshToken(rawToken);
  }

  async getUser(userId: string): Promise<UserResponse> {
    const [user] = await this.database.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!user) throw new AppException(ERROR_CODES.UNAUTHORIZED, '使用者不存在。');
    return toUserResponse(user);
  }

  private async createSession(
    user: typeof schema.users.$inferSelect,
    meta: { userAgent?: string; ip?: string },
  ): Promise<AuthSession> {
    const refresh = await this.tokenService.issueRefreshToken(user.id, meta);
    return {
      user: toUserResponse(user),
      accessToken: this.tokenService.signAccessToken({ sub: user.id, username: user.username }),
      refresh,
    };
  }
}

export function toUserResponse(user: typeof schema.users.$inferSelect): UserResponse {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}
