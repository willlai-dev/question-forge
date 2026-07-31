import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { statsOverviewResponseSchema, type StatsOverviewResponse } from '@repo/contracts';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser, type AuthenticatedUser } from '../../common/decorators';
import { StatsService } from './stats.service';

export class StatsOverviewResponseDto extends createZodDto(statsOverviewResponseSchema) {}

@ApiTags('stats')
@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('overview')
  @ApiOperation({
    summary: '學習概況',
    description: '正確率相關數字一律排除爭議題待審期間的作答（is_provisional = true）。',
  })
  @ApiOkResponse({ type: StatsOverviewResponseDto })
  overview(@CurrentUser() user: AuthenticatedUser): Promise<StatsOverviewResponse> {
    return this.stats.overview(user.id);
  }
}
