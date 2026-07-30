import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Env } from '@repo/contracts';
import { createDatabase, type DatabaseHandle } from '@repo/db';
import Redis from 'ioredis';

import { ENV, loadEnv } from '../config/env.config';

export const DATABASE = Symbol('DATABASE');
export const REDIS = Symbol('REDIS');

/**
 * 基礎設施模組：集中建立 PostgreSQL 與 Redis 連線。
 *
 * 設為 @Global 是因為幾乎每個模組都需要資料庫；
 * 但連線「建立」只發生在這裡一處，方便關機時統一釋放。
 */
@Global()
@Module({
  providers: [
    {
      provide: ENV,
      useFactory: (): Env => loadEnv(),
    },
    {
      provide: DATABASE,
      inject: [ENV],
      useFactory: (env: Env): DatabaseHandle =>
        createDatabase({ connectionString: env.DATABASE_URL }),
    },
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: Env): Redis =>
        new Redis(env.REDIS_URL, {
          // BullMQ 要求此值為 null，否則長時間阻塞指令會被中斷。
          maxRetriesPerRequest: null,
          // 啟動時不立即連線，讓健康檢查能明確回報 Redis 未就緒，而不是讓整個服務起不來。
          lazyConnect: true,
          enableOfflineQueue: true,
        }),
    },
  ],
  exports: [ENV, DATABASE, REDIS],
})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.database.close(), this.redis.quit()]);
  }
}
