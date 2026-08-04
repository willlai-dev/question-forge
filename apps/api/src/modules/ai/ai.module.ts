import { Module } from '@nestjs/common';
import type { Env } from '@repo/contracts';

import { ENV } from '../../config/env.config';
import { QuizModule } from '../quiz/quiz.module';
import { StatsModule } from '../stats/stats.module';
import { TagsModule } from '../tags/tags.module';
import { AggregateAnalysisService } from './aggregate-analysis.service';
import { AiController, AggregateAnalysesController, AnswerConflictsController, QuestionAnalysisController } from './ai.controller';
import { AiGatewayService } from './ai-gateway.service';
import { AiJobsService } from './ai-jobs.service';
import { AiQueueService } from './ai-queue.service';
import { AnalysisReadService } from './analysis-read.service';
import { ConflictsService } from './conflicts.service';
import { EvidenceService } from './evidence.service';
import { NotesService } from './notes.service';
import { PromptBuilder } from './prompts/prompt-builder';
import { PromptSeedService } from './prompts/prompt-seed.service';
import { AI_PROVIDER, type AiProvider } from './providers/ai-provider';
import { MockAiProvider } from './providers/mock-ai.provider';
import { NvidiaAiProvider } from './providers/nvidia-ai.provider';
import { QuestionAnalysisService } from './question-analysis.service';
import { AiConcurrencyLimiter, AiRateLimiterService } from './rate-limiter.service';
import { MockSearchProvider } from './search/mock-search.provider';
import { SEARCH_PROVIDER, type SearchProvider } from './search/search-provider';
import { TavilySearchProvider } from './search/tavily-search.provider';

/**
 * AI 分析模組。
 *
 * Provider 由環境變數 `AI_PROVIDER` / `SEARCH_PROVIDER` 決定，
 * 讓端到端測試可以在不消耗額度、也不依賴網路的情況下跑完整條流程。
 * 兩個 Mock 都是正式的 provider 實作，不是測試替身的臨時 hack。
 */
@Module({
  // QuizModule 只為了取得 MistakeRecordsService：建立與裁決答案爭議都會改變
  // 「哪些作答算數」，錯題紀錄必須跟著重算。QuizModule 不反向依賴 AiModule，無循環。
  // StatsModule 提供 AggregateStatsService：多題分析的輸入是那裡算出來的統計。
  imports: [TagsModule, QuizModule, StatsModule],
  controllers: [
    AiController,
    QuestionAnalysisController,
    AnswerConflictsController,
    AggregateAnalysesController,
  ],
  providers: [
    MockAiProvider,
    NvidiaAiProvider,
    MockSearchProvider,
    TavilySearchProvider,
    {
      provide: AI_PROVIDER,
      inject: [ENV, MockAiProvider, NvidiaAiProvider],
      useFactory: (env: Env, mock: MockAiProvider, nvidia: NvidiaAiProvider): AiProvider =>
        env.AI_PROVIDER === 'mock' ? mock : nvidia,
    },
    {
      provide: SEARCH_PROVIDER,
      inject: [ENV, MockSearchProvider, TavilySearchProvider],
      useFactory: (env: Env, mock: MockSearchProvider, tavily: TavilySearchProvider): SearchProvider =>
        env.SEARCH_PROVIDER === 'mock' ? mock : tavily,
    },
    AiRateLimiterService,
    AiConcurrencyLimiter,
    AiGatewayService,
    EvidenceService,
    NotesService,
    PromptBuilder,
    PromptSeedService,
    QuestionAnalysisService,
    AggregateAnalysisService,
    AiQueueService,
    AiJobsService,
    AnalysisReadService,
    ConflictsService,
  ],
  exports: [PromptSeedService],
})
export class AiModule {}
