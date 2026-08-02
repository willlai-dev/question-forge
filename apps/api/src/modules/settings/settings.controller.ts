import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  maintenanceCleanupResultSchema,
  maintenanceCleanupSchema,
  maintenancePreviewSchema,
  settingsResponseSchema,
  updateSettingsSchema,
  type MaintenanceCleanupResult,
  type MaintenancePreview,
  type SettingsResponse,
} from '@repo/contracts';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser, type AuthenticatedUser } from '../../common/decorators';
import { SettingsService } from './settings.service';

export class UpdateSettingsDto extends createZodDto(updateSettingsSchema) {}
export class SettingsResponseDto extends createZodDto(settingsResponseSchema) {}
export class MaintenancePreviewDto extends createZodDto(maintenancePreviewSchema) {}
export class MaintenanceCleanupDto extends createZodDto(maintenanceCleanupSchema) {}
export class MaintenanceCleanupResultDto extends createZodDto(maintenanceCleanupResultSchema) {}

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({
    summary: '系統設定',
    description:
      '作答預設值（可改）與系統資訊（唯讀）。機密一律只回傳「有沒有設定」，永遠不含內容。',
  })
  @ApiOkResponse({ type: SettingsResponseDto })
  get(): Promise<SettingsResponse> {
    return this.settings.get();
  }

  @Patch()
  @ApiOperation({
    summary: '更新設定',
    description: '目前只有作答預設值可改。部分更新也會用完整 schema 重新驗證合併結果。',
  })
  @ApiOkResponse({ type: SettingsResponseDto })
  update(@Body() dto: UpdateSettingsDto): Promise<SettingsResponse> {
    return this.settings.update(dto);
  }
}

/**
 * 維護作業。手動觸發，先預覽再執行。
 *
 * 刻意不做自動排程：單機自用的工具關機時排程不會執行，
 * 而「會自己刪資料的背景程序」風險高於效益。
 */
@ApiTags('settings')
@Controller('maintenance')
export class MaintenanceController {
  constructor(private readonly settings: SettingsService) {}

  @Get('preview')
  @ApiOperation({
    summary: '預覽將被清理的資料',
    description: '只計數，不刪除任何東西。',
  })
  @ApiOkResponse({ type: MaintenancePreviewDto })
  preview(): Promise<MaintenancePreview> {
    return this.settings.previewMaintenance();
  }

  @Post('cleanup')
  @HttpCode(200)
  @ApiOperation({
    summary: '執行清理',
    description:
      '只刪除「已過期且沒有任何證據集合引用」的網頁快取——' +
      '被引用的來源即使過期也保留，否則既有解析的引用會指向不存在的東西（驗收 #16）。' +
      '證據集合本身一律不刪：它是既有解析的依據。',
  })
  @ApiOkResponse({ type: MaintenanceCleanupResultDto })
  cleanup(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MaintenanceCleanupDto,
  ): Promise<MaintenanceCleanupResult> {
    return this.settings.cleanup(user.id, dto);
  }
}
