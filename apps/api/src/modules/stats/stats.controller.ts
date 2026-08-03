import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AGGREGATE_DEFAULT_PERIOD_DAYS,
  aggregateStatsQuerySchema,
  aggregateStatsResponseSchema,
  statsOverviewResponseSchema,
  type AggregateStatsResponse,
  type StatsOverviewResponse,
} from '@repo/contracts';
import { createZodDto } from 'nestjs-zod';

import { type DiagnosticTarget } from '../../common/diagnostic-scope';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators';
import { AggregateStatsService } from './aggregate-stats.service';
import { StatsService } from './stats.service';

export class StatsOverviewResponseDto extends createZodDto(statsOverviewResponseSchema) {}
export class AggregateStatsQueryDto extends createZodDto(aggregateStatsQuerySchema) {}
export class AggregateStatsResponseDto extends createZodDto(aggregateStatsResponseSchema) {}

const DAY_MS = 86_400_000;

@ApiTags('stats')
@Controller('stats')
export class StatsController {
  constructor(
    private readonly stats: StatsService,
    private readonly aggregate: AggregateStatsService,
  ) {}

  @Get('overview')
  @ApiOperation({
    summary: '學習概況',
    description:
      '所有診斷數字一律排除暫記作答、軟刪除題目，以及爭議中／已排除的題目（驗收 #18）。',
  })
  @ApiOkResponse({ type: StatsOverviewResponseDto })
  overview(@CurrentUser() user: AuthenticatedUser): Promise<StatsOverviewResponse> {
    return this.stats.overview(user.id);
  }

  @Get('aggregate')
  @ApiOperation({
    summary: '多題分析的統計彙總與代表錯題',
    description:
      '規格 §11 要求先由 PostgreSQL 完成統計、再挑選代表錯題送模型。' +
      '本端點只回傳統計與挑選結果，**完全不呼叫 AI**，' +
      '因此整條統計邏輯可以在不消耗任何額度的情況下被驗證。' +
      '省略 from／to 時預設為最近 30 天。',
  })
  @ApiOkResponse({ type: AggregateStatsResponseDto })
  aggregateStats(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AggregateStatsQueryDto,
  ): Promise<AggregateStatsResponse> {
    return this.aggregate.collect(user.id, resolvePeriod(query), resolveTarget(query));
  }
}

/** 把 query string 的範圍參數轉成統計層看得懂的形式。 */
export function resolveTarget(query: {
  scopeType?: string;
  scopeRefIds?: string;
}): DiagnosticTarget | undefined {
  if (!query.scopeType || query.scopeType === 'all') return undefined;
  const scopeRefIds = (query.scopeRefIds ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (scopeRefIds.length === 0) return undefined;
  return { scopeType: query.scopeType as DiagnosticTarget['scopeType'], scopeRefIds };
}

/** 期間預設為最近 30 天。半開區間 `[from, to)`。 */
export function resolvePeriod(query: { from?: string; to?: string }): { from: Date; to: Date } {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - AGGREGATE_DEFAULT_PERIOD_DAYS * DAY_MS);
  return { from, to };
}
