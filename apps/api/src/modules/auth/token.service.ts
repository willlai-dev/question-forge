import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ERROR_CODES, type Env } from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, eq, isNull, lt, or } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { ENV } from '../../config/env.config';
import { DATABASE } from '../../infra/infra.module';

export interface AccessTokenPayload {
  sub: string;
  username: string;
}

export interface IssuedRefreshToken {
  /** 明文 token，只會出現在 Set-Cookie 中；資料庫只存雜湊。 */
  token: string;
  expiresAt: Date;
}

/** 把 '15m'、'30d' 這類 TTL 字串轉成毫秒。 */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`無法解析的時間長度：${value}`);
  const amount = Number(match[1]);
  const unit = match[2] as 'ms' | 's' | 'm' | 'h' | 'd';
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return amount * factor;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    private readonly jwtService: JwtService,
  ) {}

  signAccessToken(payload: AccessTokenPayload): string {
    return this.jwtService.sign(payload, {
      secret: this.env.JWT_ACCESS_SECRET,
      // 以秒數傳入而非 '15m' 字串：jsonwebtoken 的字串型別是狹義的字面量聯集，
      // 而我們的 TTL 來自環境變數（一般 string），轉成秒數可避免不必要的型別斷言。
      expiresIn: Math.floor(parseDuration(this.env.JWT_ACCESS_TTL) / 1000),
    });
  }

  verifyAccessToken(token: string): AccessTokenPayload | null {
    try {
      return this.jwtService.verify<AccessTokenPayload>(token, {
        secret: this.env.JWT_ACCESS_SECRET,
      });
    } catch {
      return null;
    }
  }

  /** 產生 refresh token。資料庫只存 SHA-256 雜湊，外洩也無法還原。 */
  async issueRefreshToken(
    userId: string,
    meta: { userAgent?: string; ip?: string } = {},
  ): Promise<IssuedRefreshToken> {
    const token = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + parseDuration(this.env.JWT_REFRESH_TTL));

    await this.database.db.insert(schema.refreshTokens).values({
      userId,
      tokenHash: this.hashToken(token),
      expiresAt,
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
    });

    return { token, expiresAt };
  }

  /**
   * 輪替 refresh token。
   *
   * 若收到「已被撤銷」的 token，視為竊取訊號：撤銷該使用者所有 token 並要求重新登入。
   */
  async rotateRefreshToken(
    rawToken: string,
    meta: { userAgent?: string; ip?: string } = {},
  ): Promise<{ userId: string; refresh: IssuedRefreshToken }> {
    const tokenHash = this.hashToken(rawToken);
    const { db } = this.database;

    const [existing] = await db
      .select()
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.tokenHash, tokenHash))
      .limit(1);

    if (!existing) {
      throw new AppException(ERROR_CODES.REFRESH_TOKEN_INVALID, '登入狀態已失效，請重新登入。');
    }

    if (existing.revokedAt) {
      // 已撤銷的 token 又被使用 —— 極可能是被竊取後重放。
      this.logger.warn(`偵測到已撤銷的 refresh token 被重複使用，撤銷使用者所有工作階段`);
      await this.revokeAllForUser(existing.userId);
      throw new AppException(
        ERROR_CODES.REFRESH_TOKEN_INVALID,
        '偵測到異常的登入狀態，已登出所有工作階段，請重新登入。',
      );
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new AppException(ERROR_CODES.REFRESH_TOKEN_INVALID, '登入狀態已過期，請重新登入。');
    }

    const refresh = await this.issueRefreshToken(existing.userId, meta);
    const [replacement] = await db
      .select({ id: schema.refreshTokens.id })
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.tokenHash, this.hashToken(refresh.token)))
      .limit(1);

    await db
      .update(schema.refreshTokens)
      .set({ revokedAt: new Date(), replacedById: replacement?.id ?? null })
      .where(eq(schema.refreshTokens.id, existing.id));

    return { userId: existing.userId, refresh };
  }

  async revokeRefreshToken(rawToken: string): Promise<void> {
    await this.database.db
      .update(schema.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.refreshTokens.tokenHash, this.hashToken(rawToken)),
          isNull(schema.refreshTokens.revokedAt),
        ),
      );
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.database.db
      .update(schema.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(schema.refreshTokens.userId, userId), isNull(schema.refreshTokens.revokedAt)),
      );
  }

  /** 清理已過期或已撤銷超過保留期的紀錄（維護用）。 */
  async pruneExpired(): Promise<void> {
    const cutoff = new Date(Date.now() - parseDuration('7d'));
    await this.database.db
      .delete(schema.refreshTokens)
      .where(
        or(lt(schema.refreshTokens.expiresAt, new Date()), lt(schema.refreshTokens.revokedAt, cutoff)),
      );
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
