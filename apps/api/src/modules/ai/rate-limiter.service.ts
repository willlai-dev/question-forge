import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Env } from '@repo/contracts';
import type Redis from 'ioredis';

import { ENV } from '../../config/env.config';
import { REDIS } from '../../infra/infra.module';

/**
 * NVIDIA 呼叫的全域限流。
 *
 * 為什麼一定要自己算：規劃階段實測確認 NVIDIA **完全不回傳任何限流標頭**
 * （沒有 x-ratelimit-*，也沒有 Retry-After）。伺服器端不會告訴我們還剩多少額度，
 * 因此本地的計數器就是唯一權威來源，一旦算錯就會直接撞上免費額度上限。
 *
 * 為什麼放 Redis 而不是行程內記憶體：重啟後記憶體計數會歸零，
 * 可以在一分鐘內送出遠超額度的請求。Redis 讓計數跨重啟存活。
 *
 * 為什麼用 Lua：`INCR` 之後再判斷是否超限，中間存在競態；
 * Lua 腳本在 Redis 中是原子執行的，計數與判斷不會被插隊。
 */
@Injectable()
export class AiRateLimiterService {
  private readonly logger = new Logger(AiRateLimiterService.name);

  /**
   * 回傳 `{allowed, retryAfterMs}`。
   * 超限時一併回傳這個視窗還剩多久，呼叫端就不必自己猜要等多久。
   */
  private static readonly SCRIPT = `
    local key = KEYS[1]
    local limit = tonumber(ARGV[1])
    local windowMs = tonumber(ARGV[2])

    local current = redis.call('INCR', key)
    if current == 1 then
      redis.call('PEXPIRE', key, windowMs)
    end

    if current > limit then
      -- 已超限：把這次多加的減回去，避免計數無限膨脹讓視窗永遠打不開
      redis.call('DECR', key)
      local ttl = redis.call('PTTL', key)
      if ttl < 0 then ttl = windowMs end
      return {0, ttl}
    end

    return {1, 0}
  `;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * 嘗試取得一次呼叫額度。
   *
   * `isRetry` 為 true 時使用較高的上限：規格保留一部分額度給重試，
   * 否則正常請求會把額度用光，導致需要重試的請求永遠排不進去而整批失敗。
   */
  async tryAcquire(isRetry = false): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const limit = isRetry
      ? this.env.NVIDIA_MAX_RPM + this.env.NVIDIA_RETRY_RESERVE_RPM
      : this.env.NVIDIA_MAX_RPM;

    const windowMs = 60_000;
    const bucket = Math.floor(Date.now() / windowMs);
    const key = `ai:rpm:${bucket}`;

    try {
      const result = (await this.redis.eval(
        AiRateLimiterService.SCRIPT,
        1,
        key,
        String(limit),
        String(windowMs),
      )) as [number, number];

      return { allowed: result[0] === 1, retryAfterMs: result[1] };
    } catch (error) {
      // Redis 不可用時**拒絕**呼叫，而不是放行。
      // 放行等於失去唯一的額度守門員，可能在幾秒內燒光當日免費額度。
      this.logger.error(`限流器無法連線 Redis，拒絕本次 AI 呼叫：${describe(error)}`);
      return { allowed: false, retryAfterMs: 5_000 };
    }
  }

  /** 目前這一分鐘已使用的次數，供用量頁面顯示。 */
  async currentUsage(): Promise<{ used: number; limit: number }> {
    const bucket = Math.floor(Date.now() / 60_000);
    try {
      const raw = await this.redis.get(`ai:rpm:${bucket}`);
      return { used: raw ? Number(raw) : 0, limit: this.env.NVIDIA_MAX_RPM };
    } catch {
      return { used: 0, limit: this.env.NVIDIA_MAX_RPM };
    }
  }
}

/**
 * 併發上限。
 *
 * 用行程內號誌而非 Redis：本專案的 worker 與 API 同進程（單一使用者、單一實例），
 * 跨行程協調沒有對象。實測也顯示 NVIDIA 伺服器端本身就在排隊
 * （自報 num_waiting_reqs: 41），提高併發不會更快，只會讓逾時更容易發生。
 */
@Injectable()
export class AiConcurrencyLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(@Inject(ENV) private readonly env: Env) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.env.NVIDIA_MAX_CONCURRENT) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
