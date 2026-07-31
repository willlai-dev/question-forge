import { Module } from '@nestjs/common';

import { MistakeRecordsService } from './mistake-records.service';
import { MistakesController } from './mistakes.controller';
import { MistakesService } from './mistakes.service';
import { QuizSessionsController } from './quiz-sessions.controller';
import { QuizSessionsService } from './quiz-sessions.service';

/**
 * 作答與錯題。
 *
 * 兩者刻意放在同一個模組：錯題紀錄是作答結果的衍生狀態，
 * 拆成兩個模組會讓「作答 → 更新錯題」與「錯題 → 建立重練場次」互相依賴而成環。
 */
@Module({
  controllers: [QuizSessionsController, MistakesController],
  providers: [QuizSessionsService, MistakesService, MistakeRecordsService],
  exports: [QuizSessionsService],
})
export class QuizModule {}
