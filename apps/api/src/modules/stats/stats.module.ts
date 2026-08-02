import { Module } from '@nestjs/common';

import { AggregateStatsService } from './aggregate-stats.service';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

/**
 * 統計。
 *
 * `AggregateStatsService` 對外匯出給 AiModule 使用：多題分析的輸入就是這裡算出來的統計。
 * 本模組刻意不 import 任何模組，AiModule → StatsModule 因此不會形成循環。
 */
@Module({
  controllers: [StatsController],
  providers: [StatsService, AggregateStatsService],
  exports: [AggregateStatsService],
})
export class StatsModule {}
