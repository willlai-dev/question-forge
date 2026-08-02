import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  buildEvidenceSynthesisSchema,
  buildFinalExplanationSchema,
  ERROR_CODES,
  evidenceSynthesisSchema,
  finalExplanationSchema,
  normalizeTagName,
  researchPlanSchema,
  type AiProgressStep,
  type Env,
  type EvidenceSource,
  type EvidenceSynthesis,
  type FinalExplanation,
  type ResearchPlan,
} from '@repo/contracts';
import { computeMistakeAnalysisCacheKey } from '@repo/contracts/server';
import { schema, type Database, type DatabaseHandle } from '@repo/db';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { ENV } from '../../config/env.config';
import { DATABASE } from '../../infra/infra.module';
import { MistakeRecordsService } from '../quiz/mistake-records.service';
import { TagAliasesService } from '../tags/tag-aliases.service';
import { AiGatewayService } from './ai-gateway.service';
import { EvidenceService } from './evidence.service';
import { PromptBuilder, type AllowedVocabulary, type QuestionContext } from './prompts/prompt-builder';
import { PromptSeedService } from './prompts/prompt-seed.service';

export interface AnalysisJobInput {
  aiJobId: string;
  userId: string;
  questionId: string;
  userAnswerId: string | null;
  force: boolean;
}

type ProgressReporter = (step: AiProgressStep) => Promise<void>;

/**
 * 單題三階段分析（規格 §9）。
 *
 * 一個 job 內最多 3 次模型呼叫：
 *   ① 研究規劃 → ② 程式搜尋擷取（無 AI）→ ③ 證據整理 → ④ 最終解析 → ⑤ 保存
 *
 * 貫穿全流程的原則：**AI 的輸出不會直接變成系統狀態。**
 * 引用要驗證來源存在、標籤要對得上既有詞彙、質疑答案只能產生待審爭議。
 */
@Injectable()
export class QuestionAnalysisService {
  private readonly logger = new Logger(QuestionAnalysisService.name);

  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(ENV) private readonly env: Env,
    private readonly gateway: AiGatewayService,
    private readonly evidence: EvidenceService,
    private readonly prompts: PromptBuilder,
    private readonly promptSeed: PromptSeedService,
    private readonly tagAliases: TagAliasesService,
    private readonly mistakeRecords: MistakeRecordsService,
  ) {}

  async run(input: AnalysisJobInput, report: ProgressReporter): Promise<{ servedFromCache: boolean }> {
    const question = await this.loadQuestion(input.userId, input.questionId);

    if (!input.force) {
      const cached = await this.findUsableCache(input, question.contentHash);
      if (cached) {
        this.logger.log(`題目 ${input.questionId} 命中快取，未呼叫模型`);
        await report('COMPLETED');
        return { servedFromCache: true };
      }
    }

    // ① 研究規劃
    await report('ANALYZING_QUESTION');
    const vocabulary = await this.loadVocabulary(input.userId);
    const plan = await this.planResearch(input, question.context, vocabulary.knowledgeTags);

    // ② 搜尋與擷取（程式執行，不呼叫模型）
    await report('SEARCHING_SOURCES');
    const sources = plan.needsExternalSearch ? await this.evidence.collect(plan.queries) : [];

    // ③ 證據整理
    await report('SYNTHESIZING_EVIDENCE');
    const synthesis = await this.synthesize(input, question.context, plan, sources);

    // ④ 最終解析
    await report('GENERATING_EXPLANATION');
    const userAnswer = await this.loadUserAnswer(input.userId, input.userAnswerId);
    const final = await this.explain(input, question.context, plan, sources, synthesis, vocabulary, userAnswer);

    // ⑤ 保存
    await report('SAVING_RESULT');
    await this.persist({
      input,
      question,
      plan,
      sources,
      synthesis,
      final,
      vocabulary,
      userAnswer,
    });

    await report('COMPLETED');
    return { servedFromCache: false };
  }

  // ------------------------------------------------------------ 三次模型呼叫

  private async planResearch(
    input: AnalysisJobInput,
    question: QuestionContext,
    availableTags: string[],
  ): Promise<ResearchPlan> {
    const { data } = await this.gateway.call({
      operation: 'research_plan',
      messages: this.prompts.buildResearchPlan(question, availableTags),
      requestSchema: researchPlanSchema,
      responseSchema: researchPlanSchema,
      maxTokens: this.env.AI_MAX_TOKENS_PLAN,
      reasoningEffort: this.env.AI_REASONING_EFFORT_PLAN,
      userId: input.userId,
      aiJobId: input.aiJobId,
      promptVersion: this.promptSeed.activeVersion('research_plan'),
    });
    return data;
  }

  private async synthesize(
    input: AnalysisJobInput,
    question: QuestionContext,
    plan: ResearchPlan,
    sources: EvidenceSource[],
  ): Promise<EvidenceSynthesis> {
    const { data } = await this.gateway.call({
      operation: 'evidence_synthesis',
      messages: this.prompts.buildEvidenceSynthesis(question, plan, sources),
      requestSchema: evidenceSynthesisSchema,
      // 語意驗證需要知道「本次有哪些來源」，因此在這裡才組出完整 schema。
      responseSchema: buildEvidenceSynthesisSchema({
        allowedSourceIds: new Set(sources.map((s) => s.sourceId)),
        optionKeys: new Set(question.options.map((o) => o.key)),
        isSingleChoice: question.type === 'single_choice',
      }),
      maxTokens: this.env.AI_MAX_TOKENS_EVIDENCE,
      reasoningEffort: this.env.AI_REASONING_EFFORT_EVIDENCE,
      userId: input.userId,
      aiJobId: input.aiJobId,
      promptVersion: this.promptSeed.activeVersion('evidence_synthesis'),
    });
    return data;
  }

  private async explain(
    input: AnalysisJobInput,
    question: QuestionContext,
    plan: ResearchPlan,
    sources: EvidenceSource[],
    synthesis: EvidenceSynthesis,
    vocabulary: AllowedVocabulary,
    userAnswer: { selectedAnswers: string[]; isCorrect: boolean; relatedMistakeCount: number } | null,
  ): Promise<FinalExplanation> {
    const { data } = await this.gateway.call({
      operation: 'final_explanation',
      messages: this.prompts.buildFinalExplanation({
        question,
        plan,
        sources,
        evidenceSummary: synthesis.evidenceSummary,
        userAnswer,
        vocabulary,
      }),
      requestSchema: finalExplanationSchema,
      responseSchema: buildFinalExplanationSchema({
        allowedSourceIds: new Set(sources.map((s) => s.sourceId)),
        optionKeys: new Set(question.options.map((o) => o.key)),
        allowedErrorTypeCodes: new Set(vocabulary.errorTypes.map((t) => t.code)),
        fallbackErrorTypeCode: vocabulary.fallbackErrorTypeCode,
        researchMode: plan.researchMode,
      }),
      maxTokens: this.env.AI_MAX_TOKENS_FINAL,
      reasoningEffort: this.env.AI_REASONING_EFFORT_FINAL,
      userId: input.userId,
      aiJobId: input.aiJobId,
      promptVersion: this.promptSeed.activeVersion('final_explanation'),
    });
    return data;
  }

  // ------------------------------------------------------------ 保存

  private async persist(args: {
    input: AnalysisJobInput;
    question: Awaited<ReturnType<QuestionAnalysisService['loadQuestion']>>;
    plan: ResearchPlan;
    sources: EvidenceSource[];
    synthesis: EvidenceSynthesis;
    final: FinalExplanation;
    vocabulary: AllowedVocabulary;
    userAnswer: { selectedAnswers: string[]; isCorrect: boolean } | null;
  }): Promise<void> {
    const { input, question, plan, sources, synthesis, final, vocabulary, userAnswer } = args;

    const citedSourceIds = new Set(final.citations.map((c) => c.sourceId));
    const expiresAt = new Date(Date.now() + this.env.EVIDENCE_STALE_AFTER_DAYS * 86_400_000);

    await this.database.db.transaction(async (tx) => {
      const evidenceSet = await tx
        .insert(schema.questionEvidenceSets)
        .values({
          questionId: input.questionId,
          aiJobId: input.aiJobId,
          researchMode: plan.researchMode,
          plan,
          queries: plan.queries,
          evidenceSummary: synthesis.evidenceSummary,
          supportedClaims: synthesis.supportedClaims,
          contradictedClaims: synthesis.contradictedClaims,
          conflicts: synthesis.conflicts,
          insufficientEvidence: synthesis.insufficientEvidence,
          recommendedAnswers: synthesis.recommendedAnswer,
          confidence: synthesis.confidence.toFixed(3),
          requiresHumanReview: synthesis.requiresHumanReview,
          expiresAt,
        })
        .returning({ id: schema.questionEvidenceSets.id });

      const evidenceSetId = evidenceSet[0]!.id;
      await this.evidence.persistSources(tx, evidenceSetId, sources, citedSourceIds);

      // 標籤：對得上既有詞彙才寫入，對不上一律進建議（FR-TAG-06）。
      const tagResult = await this.applyTags(tx, input.userId, input.questionId, final);

      // 舊的現行解析標記為已被取代，不刪除 —— 歷史結果要能回溯。
      await tx
        .update(schema.questionAiEnrichments)
        .set({ isCurrent: false, supersededAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(schema.questionAiEnrichments.questionId, input.questionId),
            eq(schema.questionAiEnrichments.isCurrent, true),
          ),
        );

      await tx.insert(schema.questionAiEnrichments).values({
        questionId: input.questionId,
        questionContentHash: question.contentHash,
        evidenceSetId,
        promptVersionPlan: this.promptSeed.activeVersion('research_plan'),
        promptVersionEvidence: this.promptSeed.activeVersion('evidence_synthesis'),
        promptVersionFinal: this.promptSeed.activeVersion('final_explanation'),
        model: this.gateway.model,
        researchMode: plan.researchMode,
        canonicalExplanation: final.explanation.summary,
        coreConcept: final.explanation.coreConcept,
        solutionSteps: final.explanation.solutionSteps,
        optionAnalysis: final.optionAnalysis,
        answerValidation: final.answerValidation,
        primaryKnowledgeTagId: tagResult.primaryTagId,
        confidence: final.confidence.toFixed(3),
        requiresHumanReview: final.requiresHumanReview,
        rawOutput: final,
        isCurrent: true,
      });

      // 個人化錯因分析：只有帶了作答才產生。
      if (input.userAnswerId && userAnswer) {
        const errorType = vocabulary.errorTypes.find(
          (t) => t.code === final.mistakeAnalysis.errorTypeCode,
        );
        const errorTypeId = errorType ? await this.errorTypeId(tx, errorType.code) : null;

        const cacheKey = computeMistakeAnalysisCacheKey({
          questionId: input.questionId,
          questionVersion: question.currentVersion,
          selectedAnswers: userAnswer.selectedAnswers,
          correctAnswers: question.context.correctAnswers,
          promptVersion: this.promptSeed.activeVersion('final_explanation'),
          model: this.gateway.model,
        });

        await tx
          .insert(schema.personalizedMistakeAnalyses)
          .values({
            userId: input.userId,
            questionId: input.questionId,
            userAnswerId: input.userAnswerId,
            cacheKey,
            selectedAnswers: userAnswer.selectedAnswers,
            correctAnswers: question.context.correctAnswers,
            questionVersion: question.currentVersion,
            promptVersion: this.promptSeed.activeVersion('final_explanation'),
            model: this.gateway.model,
            userWasCorrect: final.mistakeAnalysis.userWasCorrect,
            whyWrong: final.mistakeAnalysis.whyUserMightBeWrong,
            missedConditions: final.mistakeAnalysis.missedConditions,
            errorTypeId,
            reviewSuggestions: final.mistakeAnalysis.reviewSuggestions,
            citations: final.citations,
            confidence: final.confidence.toFixed(3),
            requiresHumanReview: final.requiresHumanReview,
            rawOutput: final.mistakeAnalysis,
          })
          .onConflictDoNothing({ target: schema.personalizedMistakeAnalyses.cacheKey });

        // 錯題的錯誤類型標記（source = 'ai'，不覆蓋使用者的手動標記）。
        if (errorTypeId && !final.mistakeAnalysis.userWasCorrect) {
          await this.markErrorType(tx, input.userId, input.questionId, errorTypeId);
        }
      }

      // 答案爭議：AI 只能提出質疑，絕不自行修改題庫答案（規格 §10）。
      if (!final.answerValidation.agreesWithStoredAnswer) {
        await this.raiseConflict(tx, {
          input,
          evidenceSetId,
          storedAnswers: question.context.correctAnswers,
          final,
          citedSourceIds: [...citedSourceIds],
        });
      }
    });
  }

  /**
   * 把 AI 給的標籤名稱套用到題目。
   *
   * 對得上既有標籤 → 寫入關聯（source = 'ai'）
   * 對不上 → **丟棄該標籤**，改寫入 tag_suggestions 等人工審核
   *
   * AI 永遠不能建立正式標籤（規格 §8、驗收標準 #12）。
   */
  private async applyTags(
    tx: Database,
    userId: string,
    questionId: string,
    final: FinalExplanation,
  ): Promise<{ primaryTagId: string | null; pending: string[] }> {
    const pending: string[] = [];

    const resolveOne = async (name: string): Promise<string | null> => {
      const resolved = await this.tagAliases.resolve(userId, { tagKind: 'knowledge', name });
      if (resolved.matchedTagId) return resolved.matchedTagId;
      pending.push(name);
      return null;
    };

    const primaryTagId = await resolveOne(final.mistakeAnalysis.primaryKnowledgeTag);
    const secondaryIds: string[] = [];
    for (const name of final.mistakeAnalysis.secondaryKnowledgeTags) {
      const id = await resolveOne(name);
      if (id && id !== primaryTagId) secondaryIds.push(id);
    }

    // 只在題目還沒有人工標註時才寫入 AI 的判斷 ——
    // 使用者手動設定的標籤不該被自動覆蓋。
    const existing = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.questionKnowledgeTags)
      .where(eq(schema.questionKnowledgeTags.questionId, questionId));

    if ((existing[0]?.count ?? 0) === 0 && primaryTagId) {
      await tx
        .insert(schema.questionKnowledgeTags)
        .values([
          { questionId, knowledgeTagId: primaryTagId, role: 'primary', source: 'ai' },
          ...secondaryIds.slice(0, 2).map((id) => ({
            questionId,
            knowledgeTagId: id,
            role: 'secondary',
            source: 'ai',
          })),
        ])
        .onConflictDoNothing();
    }

    // AI 明確提出的新標籤建議，加上解析不到的名稱，全部進待審佇列。
    const suggestions = [
      ...final.mistakeAnalysis.suggestedNewTags.map((tag) => ({
        kind: tag.kind,
        name: tag.name,
        rationale: tag.rationale,
      })),
      ...pending.map((name) => ({
        kind: 'knowledge' as const,
        name,
        rationale: 'AI 分析時提到，但系統中沒有對應的標籤。',
      })),
    ];

    for (const suggestion of suggestions) {
      await tx
        .insert(schema.tagSuggestions)
        .values({
          userId,
          tagKind: suggestion.kind,
          suggestedName: suggestion.name,
          normalizedName: normalizeTagName(suggestion.name),
          contextQuestionId: questionId,
          source: 'ai',
          rationale: suggestion.rationale,
        })
        .onConflictDoUpdate({
          target: [
            schema.tagSuggestions.userId,
            schema.tagSuggestions.tagKind,
            schema.tagSuggestions.normalizedName,
          ],
          targetWhere: sql`status = 'pending'`,
          set: {
            occurrenceCount: sql`${schema.tagSuggestions.occurrenceCount} + 1`,
            updatedAt: new Date(),
          },
        })
        .catch(() => {
          // 建議寫入失敗不該讓整份分析失敗；它是附加價值而非核心結果。
        });
    }

    return { primaryTagId, pending };
  }

  /**
   * 建立答案爭議並讓題目進入 disputed 狀態。
   *
   * 連鎖效果（驗收標準 #18）：
   *   1. questions.status = 'disputed'
   *   2. 該題新的作答 is_provisional = true（由 quiz 模組在寫入時判斷）
   *   3. **該題既有的作答一併補標為 provisional**
   *   4. 錯題紀錄重算，讓錯題本與統計一致
   *   5. 統計查詢一律排除 provisional（Phase 2 就已寫入查詢條件）
   *
   * 第 3 步不能省：is_provisional 只在寫入作答的當下依題目狀態決定，
   * 而爭議一定是「先答錯、才拿去分析」才產生的 —— 觸發這次分析的那一筆作答
   * 必然早於 disputed 狀態。少了這步，最該被排除的那筆反而會留在診斷裡。
   */
  private async raiseConflict(
    tx: Database,
    args: {
      input: AnalysisJobInput;
      evidenceSetId: string;
      storedAnswers: string[];
      final: FinalExplanation;
      citedSourceIds: string[];
    },
  ): Promise<void> {
    const { input, evidenceSetId, storedAnswers, final, citedSourceIds } = args;

    const inserted = await tx
      .insert(schema.answerConflicts)
      .values({
        questionId: input.questionId,
        evidenceSetId,
        aiJobId: input.aiJobId,
        storedAnswers,
        verifiedAnswers: final.answerValidation.verifiedAnswers,
        confidence: final.answerValidation.confidence.toFixed(3),
        conflictReason: final.answerValidation.conflictReason ?? 'AI 認為題庫答案可能有誤。',
        evidence: final.citations,
        sourceIds: citedSourceIds,
        requiresReview: true,
      })
      // 同一題已有待審爭議時不重複建立（部分唯一索引也會擋）。
      .onConflictDoNothing()
      .returning({ id: schema.answerConflicts.id });

    if (inserted.length === 0) return;

    const now = new Date();

    await tx
      .update(schema.questions)
      .set({ status: 'disputed', updatedAt: now })
      .where(eq(schema.questions.id, input.questionId));

    const affected = await tx
      .update(schema.userAnswers)
      .set({ isProvisional: true, updatedAt: now })
      .where(
        and(
          eq(schema.userAnswers.questionId, input.questionId),
          eq(schema.userAnswers.isProvisional, false),
        ),
      )
      .returning({ userId: schema.userAnswers.userId });

    // 作答不再算數，錯題紀錄就得跟著重算（recompute 只看非 provisional 的歷史）。
    for (const userId of new Set(affected.map((row) => row.userId))) {
      await this.mistakeRecords.recompute(tx, userId, input.questionId);
    }

    this.logger.warn(
      `題目 ${input.questionId} 產生答案爭議，已標記為 disputed；` +
        `${affected.length} 筆既有作答改為暫記，已排除於能力診斷之外`,
    );
  }

  private async markErrorType(
    tx: Database,
    userId: string,
    questionId: string,
    errorTypeId: string,
  ): Promise<void> {
    const rows = await tx
      .select({ id: schema.mistakeRecords.id })
      .from(schema.mistakeRecords)
      .where(
        and(
          eq(schema.mistakeRecords.userId, userId),
          eq(schema.mistakeRecords.questionId, questionId),
        ),
      )
      .limit(1);

    const record = rows[0];
    if (!record) return;

    await tx
      .insert(schema.mistakeRecordErrorTypes)
      .values({ mistakeRecordId: record.id, errorTypeId, source: 'ai' })
      .onConflictDoNothing();

    await tx
      .update(schema.mistakeRecords)
      .set({ lastErrorTypeId: errorTypeId, updatedAt: new Date() })
      .where(eq(schema.mistakeRecords.id, record.id));
  }

  // ------------------------------------------------------------ 讀取與快取

  /**
   * 判斷既有解析是否還能用（規格 §12 的快取失效規則）。
   *
   * 任一條件不成立就要重新研究：題目內容雜湊變了、prompt 版本變了、
   * 模型變了、證據過期了。全部成立才直接沿用，**完全不呼叫模型** ——
   * 這是控制免費額度消耗最有效的手段。
   */
  private async findUsableCache(input: AnalysisJobInput, contentHash: string): Promise<boolean> {
    const rows = await this.database.db
      .select({
        id: schema.questionAiEnrichments.id,
        contentHash: schema.questionAiEnrichments.questionContentHash,
        model: schema.questionAiEnrichments.model,
        planVersion: schema.questionAiEnrichments.promptVersionPlan,
        evidenceVersion: schema.questionAiEnrichments.promptVersionEvidence,
        finalVersion: schema.questionAiEnrichments.promptVersionFinal,
        expiresAt: schema.questionEvidenceSets.expiresAt,
      })
      .from(schema.questionAiEnrichments)
      .leftJoin(
        schema.questionEvidenceSets,
        eq(schema.questionEvidenceSets.id, schema.questionAiEnrichments.evidenceSetId),
      )
      .where(
        and(
          eq(schema.questionAiEnrichments.questionId, input.questionId),
          eq(schema.questionAiEnrichments.isCurrent, true),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return false;

    if (row.contentHash !== contentHash) return false;
    if (row.model !== this.gateway.model) return false;
    if (row.planVersion !== this.promptSeed.activeVersion('research_plan')) return false;
    if (row.evidenceVersion !== this.promptSeed.activeVersion('evidence_synthesis')) return false;
    if (row.finalVersion !== this.promptSeed.activeVersion('final_explanation')) return false;
    if (row.expiresAt !== null && row.expiresAt.getTime() < Date.now()) return false;

    // 帶了作答時，個人化分析也必須已經存在，否則仍要重新產生。
    if (input.userAnswerId) {
      const answer = await this.loadUserAnswer(input.userId, input.userAnswerId);
      if (!answer) return true;

      const question = await this.loadQuestion(input.userId, input.questionId);
      const cacheKey = computeMistakeAnalysisCacheKey({
        questionId: input.questionId,
        questionVersion: question.currentVersion,
        selectedAnswers: answer.selectedAnswers,
        correctAnswers: question.context.correctAnswers,
        promptVersion: this.promptSeed.activeVersion('final_explanation'),
        model: this.gateway.model,
      });

      const personalized = await this.database.db
        .select({ id: schema.personalizedMistakeAnalyses.id })
        .from(schema.personalizedMistakeAnalyses)
        .where(eq(schema.personalizedMistakeAnalyses.cacheKey, cacheKey))
        .limit(1);

      return personalized.length > 0;
    }

    return true;
  }

  private async loadQuestion(userId: string, questionId: string) {
    const rows = await this.database.db
      .select({
        question: schema.questions,
        subjectName: schema.subjects.name,
        chapterName: schema.chapters.name,
        groupName: schema.questionGroups.name,
      })
      .from(schema.questions)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questions.subjectId))
      .innerJoin(
        schema.questionGroups,
        eq(schema.questionGroups.id, schema.questions.questionGroupId),
      )
      .leftJoin(schema.chapters, eq(schema.chapters.id, schema.questions.chapterId))
      .where(
        and(
          eq(schema.questions.id, questionId),
          eq(schema.questions.userId, userId),
          isNull(schema.questions.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppException(ERROR_CODES.QUESTION_NOT_FOUND, '找不到指定的題目。');

    const options = await this.database.db
      .select()
      .from(schema.questionOptions)
      .where(eq(schema.questionOptions.questionId, questionId))
      .orderBy(schema.questionOptions.sortOrder);

    const context: QuestionContext = {
      stem: row.question.stem,
      type: row.question.type,
      options: options.map((o) => ({ key: o.key, text: o.text })),
      correctAnswers: options.filter((o) => o.isCorrect).map((o) => o.key),
      existingExplanation: row.question.explanation,
      subjectName: row.subjectName,
      chapterName: row.chapterName,
      questionGroupName: row.groupName,
      sourceReference: row.question.sourceReference,
      sourcePage: row.question.sourcePage,
    };

    return {
      context,
      contentHash: row.question.contentHash,
      currentVersion: row.question.currentVersion,
    };
  }

  /** 組出 AI 可用的詞彙清單。AI 只能從這裡挑，挑不到只能提建議。 */
  private async loadVocabulary(userId: string): Promise<AllowedVocabulary> {
    const { db } = this.database;

    const [knowledge, skills, errors] = await Promise.all([
      db
        .select({ name: schema.knowledgeTags.name })
        .from(schema.knowledgeTags)
        .where(
          and(
            eq(schema.knowledgeTags.userId, userId),
            eq(schema.knowledgeTags.status, 'active'),
          ),
        ),
      db
        .select({ name: schema.skillTags.name })
        .from(schema.skillTags)
        .where(eq(schema.skillTags.status, 'active')),
      db
        .select({
          code: schema.errorTypes.code,
          name: schema.errorTypes.name,
          description: schema.errorTypes.description,
          isFallback: schema.errorTypes.isFallback,
        })
        .from(schema.errorTypes)
        .where(ne(schema.errorTypes.status, 'merged')),
    ]);

    const fallback = errors.find((e) => e.isFallback);
    if (!fallback) {
      // 沒有 fallback，模型判斷不出錯因時會被迫亂猜一個具體錯誤類型。
      throw new AppException(
        ERROR_CODES.INTERNAL_ERROR,
        '缺少 fallback 錯誤類型（無法判定），無法安全地進行 AI 分析。',
      );
    }

    return {
      knowledgeTags: knowledge.map((k) => k.name),
      skillTags: skills.map((s) => s.name),
      errorTypes: errors.map((e) => ({
        code: e.code,
        name: e.name,
        description: e.description,
      })),
      fallbackErrorTypeCode: fallback.code,
    };
  }

  private async loadUserAnswer(userId: string, userAnswerId: string | null) {
    if (!userAnswerId) return null;

    const rows = await this.database.db
      .select()
      .from(schema.userAnswers)
      .where(
        and(eq(schema.userAnswers.id, userAnswerId), eq(schema.userAnswers.userId, userId)),
      )
      .limit(1);

    const answer = rows[0];
    if (!answer) return null;

    const mistake = await this.database.db
      .select({ mistakeCount: schema.mistakeRecords.mistakeCount })
      .from(schema.mistakeRecords)
      .where(
        and(
          eq(schema.mistakeRecords.userId, userId),
          eq(schema.mistakeRecords.questionId, answer.questionId),
        ),
      )
      .limit(1);

    return {
      selectedAnswers: answer.selectedAnswers,
      isCorrect: answer.isCorrect,
      relatedMistakeCount: mistake[0]?.mistakeCount ?? 0,
    };
  }

  private async errorTypeId(tx: Database, code: string): Promise<string | null> {
    const rows = await tx
      .select({ id: schema.errorTypes.id })
      .from(schema.errorTypes)
      .where(eq(schema.errorTypes.code, code))
      .limit(1);
    return rows[0]?.id ?? null;
  }
}
