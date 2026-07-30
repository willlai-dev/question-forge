import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';

import { RequestIdMiddleware } from './common/request-id.middleware';
import { InfraModule } from './infra/infra.module';
import { HealthModule } from './modules/health/health.module';

/**
 * 應用程式根模組（模組化單體）。
 *
 * Phase 0 只掛載基礎設施與健康檢查。
 * Phase 1 起依 docs/IMPLEMENTATION_PLAN.md 逐步加入：
 *   AuthModule / SubjectsModule / ChaptersModule / QuestionGroupsModule / QuestionsModule /
 *   ImportsModule / TagsModule / QuizModule / MistakesModule / AiModule /
 *   ConflictsModule / StatsModule / SettingsModule
 */
@Module({
  imports: [InfraModule, HealthModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
