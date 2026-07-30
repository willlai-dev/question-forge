import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HealthService, type DependenciesReport } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({
    summary: '存活檢查',
    description: '不觸碰任何外部相依，只確認 API 進程本身可回應。',
  })
  @ApiOkResponse({ description: 'API 進程正常運作中。' })
  liveness(): { status: 'ok'; environment: string; uptimeSeconds: number } {
    return this.healthService.liveness();
  }

  @Get('deps')
  @ApiOperation({
    summary: '相依服務檢查',
    description:
      '檢查 PostgreSQL 與 Redis 是否可用。任一服務異常時 status 會是 degraded，' +
      '但仍以 HTTP 200 回應，方便監控端自行判讀。失敗原因刻意只給分類，不含連線資訊。',
  })
  @ApiOkResponse({ description: '相依服務檢查結果。' })
  dependencies(): Promise<DependenciesReport> {
    return this.healthService.dependencies();
  }
}
