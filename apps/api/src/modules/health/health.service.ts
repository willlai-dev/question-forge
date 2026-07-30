import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@repo/contracts';
import { pingDatabase, type DatabaseHandle } from '@repo/db';
import type Redis from 'ioredis';

import { ENV } from '../../config/env.config';
import { DATABASE, REDIS } from '../../infra/infra.module';

export interface DependencyStatus {
  name: string;
  status: 'up' | 'down';
  latencyMs?: number;
  /** 失敗原因只給簡短分類，不含連線字串或密碼。 */
  reason?: string;
}

export interface DependenciesReport {
  status: 'ok' | 'degraded';
  checkedAt: string;
  dependencies: DependencyStatus[];
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  liveness(): { status: 'ok'; environment: string; uptimeSeconds: number } {
    return {
      status: 'ok',
      environment: this.env.NODE_ENV,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  async dependencies(): Promise<DependenciesReport> {
    const [postgres, redis] = await Promise.all([this.checkPostgres(), this.checkRedis()]);
    const dependencies = [postgres, redis];

    return {
      status: dependencies.every((d) => d.status === 'up') ? 'ok' : 'degraded',
      checkedAt: new Date().toISOString(),
      dependencies,
    };
  }

  private async checkPostgres(): Promise<DependencyStatus> {
    try {
      const latencyMs = await pingDatabase(this.database.pool);
      return { name: 'postgres', status: 'up', latencyMs };
    } catch {
      // 刻意吞掉原始錯誤：pg 的錯誤訊息可能包含連線資訊。
      return { name: 'postgres', status: 'down', reason: '無法連線或查詢失敗' };
    }
  }

  private async checkRedis(): Promise<DependencyStatus> {
    const startedAt = performance.now();
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'end') {
        await this.redis.connect();
      }
      await this.redis.ping();
      return { name: 'redis', status: 'up', latencyMs: Math.round(performance.now() - startedAt) };
    } catch {
      return { name: 'redis', status: 'down', reason: '無法連線或 PING 失敗' };
    }
  }
}
