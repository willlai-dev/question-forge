import { Module } from '@nestjs/common';

import { QuizModule } from '../quiz/quiz.module';
import { MaintenanceController, SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/**
 * 系統設定與維護作業。
 *
 * QuizModule 只為了取得 MistakeRecordsService：維護作業的「重算錯題統計」
 * 走的是同一支重算邏輯，不另外寫一份。
 */
@Module({
  imports: [QuizModule],
  controllers: [SettingsController, MaintenanceController],
  providers: [SettingsService],
})
export class SettingsModule {}
