import { Inject, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  type AiUsageResponse,
  type QuestionAnalysisResponse,
} from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { DATABASE } from '../../infra/infra.module';

/** 分析結果與用量的讀取。所有寫入都在其他 service，這裡只查詢。 */
@Injectable()
export class AnalysisReadService {
  constructor(@Inject(DATABASE) private readonly database: DatabaseHandle) {}

  async getQuestionAnalysis(
    userId: string,
    questionId: string,
    userAnswerId?: string | null,
  ): Promise<QuestionAnalysisResponse> {
    const { db } = this.database;

    const rows = await db
      .select({
        enrichment: schema.questionAiEnrichments,
        contentHash: schema.questions.contentHash,
      })
      .from(schema.questionAiEnrichments)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.questionAiEnrichments.questionId))
      .where(
        and(
          eq(schema.questionAiEnrichments.questionId, questionId),
          eq(schema.questionAiEnrichments.isCurrent, true),
          eq(schema.questions.userId, userId),
          isNull(schema.questions.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new AppException(ERROR_CODES.NOT_FOUND, '這一題還沒有 AI 解析。');
    }

    const enrichment = row.enrichment;

    const sources = enrichment.evidenceSetId
      ? await db
          .select()
          .from(schema.questionEvidenceSources)
          .where(eq(schema.questionEvidenceSources.evidenceSetId, enrichment.evidenceSetId))
          .orderBy(schema.questionEvidenceSources.sourceId)
      : [];

    // 個人化錯因：優先取指定的作答，沒指定就取最近一筆。
    const personalizedRows = await db
      .select({
        analysis: schema.personalizedMistakeAnalyses,
        errorTypeCode: schema.errorTypes.code,
        errorTypeName: schema.errorTypes.name,
      })
      .from(schema.personalizedMistakeAnalyses)
      .leftJoin(
        schema.errorTypes,
        eq(schema.errorTypes.id, schema.personalizedMistakeAnalyses.errorTypeId),
      )
      .where(
        and(
          eq(schema.personalizedMistakeAnalyses.userId, userId),
          eq(schema.personalizedMistakeAnalyses.questionId, questionId),
          ...(userAnswerId
            ? [eq(schema.personalizedMistakeAnalyses.userAnswerId, userAnswerId)]
            : []),
        ),
      )
      .orderBy(desc(schema.personalizedMistakeAnalyses.createdAt))
      .limit(1);

    const personalized = personalizedRows[0];

    // 還沒被審核的標籤建議，前端據此顯示「知識點待補」。
    const pendingTags = await db
      .select({ name: schema.tagSuggestions.suggestedName })
      .from(schema.tagSuggestions)
      .where(
        and(
          eq(schema.tagSuggestions.userId, userId),
          eq(schema.tagSuggestions.contextQuestionId, questionId),
          eq(schema.tagSuggestions.status, 'pending'),
        ),
      );

    return {
      questionId,
      questionContentHash: enrichment.questionContentHash,
      // 題目被改過之後，這份解析就不一定還適用，要讓使用者看得出來。
      isStale: enrichment.questionContentHash !== row.contentHash,
      researchMode: enrichment.researchMode as QuestionAnalysisResponse['researchMode'],
      model: enrichment.model,
      coreConcept: enrichment.coreConcept ?? '',
      solutionSteps: (enrichment.solutionSteps as string[] | null) ?? [],
      canonicalExplanation: enrichment.canonicalExplanation ?? '',
      optionAnalysis:
        (enrichment.optionAnalysis as QuestionAnalysisResponse['optionAnalysis'] | null) ?? [],
      answerValidation:
        (enrichment.answerValidation as QuestionAnalysisResponse['answerValidation'] | null) ?? {
          agreesWithStoredAnswer: true,
          verifiedAnswers: [],
          conflictReason: null,
          confidence: 0,
        },
      personalized: personalized
        ? {
            selectedAnswers: personalized.analysis.selectedAnswers,
            correctAnswers: personalized.analysis.correctAnswers,
            userWasCorrect: personalized.analysis.userWasCorrect,
            whyWrong: personalized.analysis.whyWrong,
            missedConditions: (personalized.analysis.missedConditions as string[] | null) ?? [],
            errorTypeCode: personalized.errorTypeCode,
            errorTypeName: personalized.errorTypeName,
            reviewSuggestions: (personalized.analysis.reviewSuggestions as string[] | null) ?? [],
            citations:
              (personalized.analysis.citations as
                | { sourceId: string; quote: string | null; relevance: string }[]
                | null) ?? [],
          }
        : null,
      sources: sources.map((source) => ({
        sourceId: source.sourceId,
        url: source.url,
        domain: source.domain,
        title: source.title,
        publishedDate: source.publishedDate,
        fetchedAt: source.fetchedAt.toISOString(),
        trustTier: source.trustTier as QuestionAnalysisResponse['sources'][number]['trustTier'],
        contentSnippet: source.contentSnippet ?? '',
        searchQuery: source.searchQuery,
        rank: source.rank,
        score: source.score === null ? null : Number(source.score),
        isUsed: source.isUsed,
      })),
      pendingTagSuggestions: pendingTags.map((tag) => tag.name),
      confidence: enrichment.confidence === null ? 0 : Number(enrichment.confidence),
      requiresHumanReview: enrichment.requiresHumanReview,
      generatedAt: enrichment.generatedAt.toISOString(),
    };
  }

  async usage(userId: string): Promise<AiUsageResponse> {
    const { db } = this.database;
    const where = eq(schema.aiUsageLogs.userId, userId);

    const [totals] = await db
      .select({
        totalCalls: sql<number>`count(*)::int`,
        successCalls: sql<number>`count(*) filter (where ${schema.aiUsageLogs.requestStatus} = 'success')::int`,
        failedCalls: sql<number>`count(*) filter (where ${schema.aiUsageLogs.requestStatus} <> 'success')::int`,
        totalInputTokens: sql<number>`coalesce(sum(${schema.aiUsageLogs.inputTokens}), 0)::int`,
        totalOutputTokens: sql<number>`coalesce(sum(${schema.aiUsageLogs.outputTokens}), 0)::int`,
        avgLatencyMs: sql<number | null>`avg(${schema.aiUsageLogs.latencyMs})::int`,
        p95LatencyMs: sql<
          number | null
        >`percentile_disc(0.95) within group (order by ${schema.aiUsageLogs.latencyMs})::int`,
      })
      .from(schema.aiUsageLogs)
      .where(where);

    const byOperation = await db
      .select({
        operation: schema.aiUsageLogs.operation,
        calls: sql<number>`count(*)::int`,
        successCalls: sql<number>`count(*) filter (where ${schema.aiUsageLogs.requestStatus} = 'success')::int`,
        avgLatencyMs: sql<number | null>`avg(${schema.aiUsageLogs.latencyMs})::int`,
        totalTokens: sql<number>`coalesce(sum(${schema.aiUsageLogs.totalTokens}), 0)::int`,
      })
      .from(schema.aiUsageLogs)
      .where(where)
      .groupBy(schema.aiUsageLogs.operation);

    const byStatus = await db
      .select({
        status: schema.aiUsageLogs.requestStatus,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.aiUsageLogs)
      .where(where)
      .groupBy(schema.aiUsageLogs.requestStatus);

    return {
      totalCalls: totals?.totalCalls ?? 0,
      successCalls: totals?.successCalls ?? 0,
      failedCalls: totals?.failedCalls ?? 0,
      totalInputTokens: totals?.totalInputTokens ?? 0,
      totalOutputTokens: totals?.totalOutputTokens ?? 0,
      avgLatencyMs: totals?.avgLatencyMs ?? null,
      p95LatencyMs: totals?.p95LatencyMs ?? null,
      byOperation: byOperation.map((row) => ({
        operation: row.operation as AiUsageResponse['byOperation'][number]['operation'],
        calls: row.calls,
        successRate: row.calls === 0 ? null : Math.round((row.successCalls / row.calls) * 10000) / 100,
        avgLatencyMs: row.avgLatencyMs,
        totalTokens: row.totalTokens,
      })),
      byStatus,
    };
  }
}
