import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';

import { RequestIdMiddleware } from './common/request-id.middleware';
import { AppZodValidationPipe } from './common/zod-validation.pipe';
import { InfraModule } from './infra/infra.module';
import { AuthModule } from './modules/auth/auth.module';
import { CsrfGuard, JwtAuthGuard } from './modules/auth/guards';
import { HealthModule } from './modules/health/health.module';
import { ImportsModule } from './modules/imports/imports.module';
import { QuestionBankModule } from './modules/question-bank/question-bank.module';
import { QuestionsModule } from './modules/questions/questions.module';
import { QuizModule } from './modules/quiz/quiz.module';
import { StatsModule } from './modules/stats/stats.module';
import { TagsModule } from './modules/tags/tags.module';
import { AiModule } from './modules/ai/ai.module';

/**
 * 應用程式根模組（模組化單體）。
 *
 * 安全預設：認證與 CSRF 守衛都是「全域啟用」，端點必須以 @Public() / @SkipCsrf()
 * 明確宣告例外。忘記加守衛不會造成端點裸奔，只有明確標註才會放行。
 *
 * Phase 2 加入 QuizModule（作答與錯題）與 StatsModule（學習概況），
 * 其後依 docs/IMPLEMENTATION_PLAN.md 逐步擴充。
 */
@Module({
  imports: [
    InfraModule,
    AuthModule,
    HealthModule,
    QuestionBankModule,
    QuestionsModule,
    ImportsModule,
    TagsModule,
    QuizModule,
    StatsModule,
    AiModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: AppZodValidationPipe },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
