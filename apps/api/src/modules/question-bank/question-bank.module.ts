import { Module } from '@nestjs/common';

import { ChaptersController } from './chapters.controller';
import { ChaptersService } from './chapters.service';
import { QuestionGroupsController } from './question-groups.controller';
import { QuestionGroupsService } from './question-groups.service';
import { SubjectsController } from './subjects.controller';
import { SubjectsService } from './subjects.service';

/**
 * 題庫階層模組：科目 → 章節 → 題組。
 *
 * 三者耦合緊密（章節必須驗證科目歸屬、題組必須同時驗證兩者），
 * 拆成三個 Nest 模組只會產生大量互相 import 而沒有實質邊界，
 * 因此收在同一個模組內，但各自維持獨立的 service 與 controller。
 *
 * 題目 CRUD 與 JSON 匯入屬 Phase 1b，會加入各自的模組。
 */
@Module({
  controllers: [SubjectsController, ChaptersController, QuestionGroupsController],
  providers: [SubjectsService, ChaptersService, QuestionGroupsService],
  exports: [SubjectsService, ChaptersService, QuestionGroupsService],
})
export class QuestionBankModule {}
