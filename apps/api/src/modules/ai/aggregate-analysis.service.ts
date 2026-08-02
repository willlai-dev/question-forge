import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  buildAggregateAnalysisSchema,
  aggregateAnalysisSchema,
  ERROR_CODES,
  type AggregateAnalysisResponse,
  type AggregateScopeType,
  type AggregateStatsResponse,
  type Env,
} from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, desc, eq } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { ENV } from '../../config/env.config';
import { DATABASE } from '../../infra/infra.module';
import { AggregateStatsService } from '../stats/aggregate-stats.service';
import { AiGatewayService } from './ai-gateway.service';
import { PromptBuilder } from './prompts/prompt-builder';
import { PromptSeedService } from './prompts/prompt-seed.service';

/** 多題分析任務的輸入。 */
export interface AggregateJobInput {
  kind: 'aggregate_analysis';
  aiJobId: string;
  userId: string;
  scopeType: AggregateScopeType;
  scopeRefIds: string[];
  periodFrom: string;
  periodTo: string;
  force: boolean;
}

type ProgressReporter = (
  step: 'COLLECTING_STATS' | 'SELECTING_QUESTIONS' | 'GENERATING_DIAGNOSIS' | 'SAVING_RESULT' | 'COMPLETED',
) => Promise<void>;

/**
 * 多題整合分析（規格 §11、FR-AGG-01～05）。
 *
 * 與單題分析的差別：
 *   - **只呼叫一次模型**。前面的統計與代表錯題挑選全由程式完成。
 *   - 不上網查證，因此沒有來源引用；參照完整性改為檢查知識點名稱、
 *     錯誤類型代碼與可推薦的複習目標 ID 是否真實存在。
 *   - 結果連同 `stats_snapshot` 一併保存，讓結論可回頭驗證（FR-AGG-05）。
 */
@Injectable()
export class AggregateAnalysisService {
  private readonly logger = new Logger(AggregateAnalysisService.name);

  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(ENV) private readonly env: Env,
    private readonly stats: AggregateStatsService,
    private readonly gateway: AiGatewayService,
    private readonly prompts: PromptBuilder,
    private readonly promptSeed: PromptSeedService,
  ) {}

  async run(
    input: AggregateJobInput,
    report: ProgressReporter,
  ): Promise<{ servedFromCache: boolean }> {
    const period = { from: new Date(input.periodFrom), to: new Date(input.periodTo) };

    await report('COLLECTING_STATS');
    const collected = await this.stats.collect(input.userId, period);

    if (collected.stats.overall.totalAnswered === 0) {
      throw new AppException(
        ERROR_CODES.VALIDATION_FAILED,
        '這段期間沒有任何可用於診斷的作答，無法產生整合分析。',
      );
    }

    await report('SELECTING_QUESTIONS');
    const errorTypes = await this.database.db
      .select({
        code: schema.errorTypes.code,
        name: schema.errorTypes.name,
        description: schema.errorTypes.description,
      })
      .from(schema.errorTypes);

    await report('GENERATING_DIAGNOSIS');
    const analysis = await this.callModel(input, collected, errorTypes);

    await report('SAVING_RESULT');
    await this.persist(input, collected, analysis);

    await report('COMPLETED');
    return { servedFromCache: false };
  }

  private async callModel(
    input: AggregateJobInput,
    collected: AggregateStatsResponse,
    errorTypes: { code: string; name: string; description: string | null }[],
  ) {
    const messages = this.prompts.buildAggregateAnalysis({
      stats: collected.stats,
      representativeQuestions: collected.representativeQuestions,
      errorTypes,
    });

    // 可以被推薦的複習目標：代表錯題、統計中出現過的題組與知識點。
    // AI 只能在這個集合裡挑，挑到集合外的就是編的，會被語意驗證擋下。
    const allowedPracticeRefIds = new Set<string>([
      ...collected.representativeQuestions.map((question) => question.questionId),
      ...collected.stats.byQuestionGroup.map((group) => group.id),
      ...collected.stats.byKnowledgeTag.map((tag) => tag.id),
    ]);

    const result = await this.gateway.call({
      operation: 'aggregate_analysis',
      messages,
      // 送給模型的 schema 必須是靜態的：gateway 以 operation 字串快取 JSON Schema，
      // 把逐次不同的詞彙烤進去只有第一次會生效。動態限制一律放在 responseSchema。
      requestSchema: aggregateAnalysisSchema,
      responseSchema: buildAggregateAnalysisSchema({
        allowedKnowledgeTagNames: new Set(collected.stats.byKnowledgeTag.map((tag) => tag.name)),
        allowedErrorTypeCodes: new Set(errorTypes.map((type) => type.code)),
        allowedPracticeRefIds,
      }),
      maxTokens: this.env.AI_MAX_TOKENS_AGGREGATE,
      reasoningEffort: this.env.AI_REASONING_EFFORT_AGGREGATE,
      userId: input.userId,
      aiJobId: input.aiJobId,
      promptVersion: this.promptSeed.activeVersion('aggregate_analysis'),
    });

    return result.data;
  }

  private async persist(
    input: AggregateJobInput,
    collected: AggregateStatsResponse,
    analysis: Awaited<ReturnType<AggregateAnalysisService['callModel']>>,
  ) {
    const [row] = await this.database.db
      .insert(schema.aggregateAnalyses)
      .values({
        userId: input.userId,
        aiJobId: input.aiJobId,
        scopeType: input.scopeType,
        scopeRefIds: input.scopeRefIds,
        periodFrom: new Date(input.periodFrom),
        periodTo: new Date(input.periodTo),
        // FR-AGG-05：統計快照與結論一起存，否則結論無從驗證。
        statsSnapshot: collected,
        representativeQuestionIds: collected.representativeQuestions.map((q) => q.questionId),
        weakestKnowledgeTags: analysis.weakestKnowledgeTags,
        commonErrorTypes: analysis.commonErrorTypes,
        errorPatterns: analysis.errorPatterns,
        reviewPriority: analysis.reviewPriority,
        recommendedGroups: analysis.recommendedPractice,
        improvement: analysis.improvement,
        suggestions: analysis.learningSuggestions,
        confidence: analysis.confidence.toFixed(3),
        promptVersion: this.promptSeed.activeVersion('aggregate_analysis'),
        model: this.gateway.model,
        rawOutput: analysis,
      })
      .returning();

    this.logger.log(`多題整合分析完成：${row!.id}`);
    return row!;
  }

  // ------------------------------------------------------------- 讀取

  async latest(userId: string): Promise<AggregateAnalysisResponse | null> {
    const rows = await this.database.db
      .select()
      .from(schema.aggregateAnalyses)
      .where(eq(schema.aggregateAnalyses.userId, userId))
      .orderBy(desc(schema.aggregateAnalyses.createdAt), desc(schema.aggregateAnalyses.id))
      .limit(1);

    return rows[0] ? this.toResponse(rows[0]) : null;
  }

  async list(userId: string, limit: number): Promise<AggregateAnalysisResponse[]> {
    const rows = await this.database.db
      .select()
      .from(schema.aggregateAnalyses)
      .where(eq(schema.aggregateAnalyses.userId, userId))
      .orderBy(desc(schema.aggregateAnalyses.createdAt), desc(schema.aggregateAnalyses.id))
      .limit(limit);

    return rows.map((row) => this.toResponse(row));
  }

  async get(userId: string, id: string): Promise<AggregateAnalysisResponse> {
    const rows = await this.database.db
      .select()
      .from(schema.aggregateAnalyses)
      .where(
        and(eq(schema.aggregateAnalyses.id, id), eq(schema.aggregateAnalyses.userId, userId)),
      )
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppException(ERROR_CODES.NOT_FOUND, '找不到指定的整合分析。');
    return this.toResponse(row);
  }

  private toResponse(row: typeof schema.aggregateAnalyses.$inferSelect): AggregateAnalysisResponse {
    const errorTypes = (row.commonErrorTypes ?? []) as {
      errorTypeCode: string;
      count: number;
      interpretation: string;
    }[];

    return {
      id: row.id,
      aiJobId: row.aiJobId,
      scopeType: row.scopeType as AggregateScopeType,
      scopeRefIds: (row.scopeRefIds ?? []) as string[],
      periodFrom: row.periodFrom.toISOString(),
      periodTo: row.periodTo.toISOString(),
      weakestKnowledgeTags: (row.weakestKnowledgeTags ?? []) as never,
      commonErrorTypes: errorTypes.map((type) => ({ ...type, name: null })),
      errorPatterns: (row.errorPatterns ?? []) as never,
      reviewPriority: (row.reviewPriority ?? []) as never,
      recommendedPractice: (row.recommendedGroups ?? []) as never,
      improvement: (row.improvement ?? {
        hasImproved: false,
        improvedAreas: [],
        stagnantAreas: [],
        summary: '',
      }) as never,
      learningSuggestions: (row.suggestions ?? []) as string[],
      analysisBasis:
        ((row.rawOutput as { analysisBasis?: string } | null)?.analysisBasis ?? ''),
      confidence: row.confidence === null ? null : Number(row.confidence),
      statsSnapshot: row.statsSnapshot,
      representativeQuestionIds: row.representativeQuestionIds,
      promptVersion: row.promptVersion,
      model: row.model,
      analysisVersion: row.analysisVersion,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
