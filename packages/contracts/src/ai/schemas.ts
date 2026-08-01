import { z } from 'zod';

import {
  aiOptionKeySchema,
  citationSchema,
  confidenceSchema,
  refineSourceIds,
  researchModeSchema,
  WEB_RESEARCH_MODES,
} from './common';

/**
 * 三階段 AI 的輸出 Schema 與語意驗證（docs/AI_ANALYSIS_SCHEMAS.md §1、§3、§4）。
 *
 * 每個階段都有兩個 schema：
 *   - `xxxSchema`：純結構，可直接轉成送給 NVIDIA 的 json_schema。
 *   - `buildXxxSchema(context)`：加上需要外部資訊才能驗證的語意規則
 *     （例如「sourceId 必須存在」需要知道本次有哪些來源）。
 *
 * 分成兩個的原因：送給模型的 schema 不能包含這些動態規則（API 不支援），
 * 但收到回應後必須用完整規則驗證。
 */

// ------------------------------------------------------------ ① 研究規劃

export const researchPlanSchema = z
  .object({
    needsExternalSearch: z.boolean(),
    researchMode: researchModeSchema,
    reason: z.string().min(1).max(1000),
    /** 規格 §9：每題最多 3 組查詢。 */
    queries: z.array(z.string().min(1).max(200)).max(3),
    preferredDomains: z.array(z.string()).max(10),
    preferredSourceTypes: z
      .array(z.enum(['official', 'academic', 'educational', 'reference', 'news', 'other']))
      .max(6),
    freshnessRequired: z.boolean(),
    keyClaimsToVerify: z.array(z.string().min(1).max(300)).max(5),
  })
  .strict()
  .superRefine((value, ctx) => {
    // 這一條是實測踩過的矛盾：模型說要搜尋，卻選了不搜尋的模式。
    if (value.needsExternalSearch && value.researchMode === 'MODEL_ONLY') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['researchMode'],
        message: 'needsExternalSearch 為 true 時不可選 MODEL_ONLY',
      });
    }
    if (
      !value.needsExternalSearch &&
      value.researchMode !== 'MODEL_ONLY' &&
      value.researchMode !== 'PDF_KNOWLEDGE'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['researchMode'],
        message: 'needsExternalSearch 為 false 時只能選 MODEL_ONLY 或 PDF_KNOWLEDGE',
      });
    }
    if (WEB_RESEARCH_MODES.includes(value.researchMode) && value.queries.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['queries'],
        message: '要進行網路研究就必須提供至少一組查詢關鍵字',
      });
    }
    if (value.researchMode === 'MODEL_ONLY' && value.queries.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['queries'],
        message: 'MODEL_ONLY 模式不應提供查詢關鍵字',
      });
    }
    if (value.needsExternalSearch && value.keyClaimsToVerify.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['keyClaimsToVerify'],
        message: '要查證就必須指出要查證什麼',
      });
    }
  });
export type ResearchPlan = z.infer<typeof researchPlanSchema>;

// ------------------------------------------------------------ ② 證據整理

const evidenceSynthesisBase = z
  .object({
    evidenceSummary: z.string().min(1).max(3000),
    supportedClaims: z
      .array(
        z.object({
          claim: z.string().min(1).max(500),
          sourceIds: z.array(z.string()).min(1),
          strength: z.enum(['strong', 'moderate', 'weak']),
        }),
      )
      .max(10),
    contradictedClaims: z
      .array(
        z.object({
          claim: z.string().min(1).max(500),
          sourceIds: z.array(z.string()).min(1),
          explanation: z.string().max(1000),
        }),
      )
      .max(10),
    conflicts: z
      .array(
        z.object({
          description: z.string().min(1).max(1000),
          /** 「衝突」至少要有兩方，否則不成其為衝突。 */
          conflictingSourceIds: z.array(z.string()).min(2),
        }),
      )
      .max(5),
    insufficientEvidence: z.boolean(),
    recommendedAnswer: z.array(aiOptionKeySchema),
    confidence: confidenceSchema,
    requiresHumanReview: z.boolean(),
  })
  .strict();

export const evidenceSynthesisSchema = evidenceSynthesisBase;
export type EvidenceSynthesis = z.infer<typeof evidenceSynthesisBase>;

export interface EvidenceSynthesisContext {
  /** 本次證據集合的 sourceId。 */
  allowedSourceIds: ReadonlySet<string>;
  /** 該題所有選項代號。 */
  optionKeys: ReadonlySet<string>;
  isSingleChoice: boolean;
}

export function buildEvidenceSynthesisSchema(context: EvidenceSynthesisContext) {
  return evidenceSynthesisBase.superRefine((value, ctx) => {
    value.supportedClaims.forEach((claim, index) => {
      refineSourceIds(claim.sourceIds, context.allowedSourceIds, ctx, [
        'supportedClaims',
        index,
        'sourceIds',
      ]);
    });
    value.contradictedClaims.forEach((claim, index) => {
      refineSourceIds(claim.sourceIds, context.allowedSourceIds, ctx, [
        'contradictedClaims',
        index,
        'sourceIds',
      ]);
    });
    value.conflicts.forEach((conflict, index) => {
      refineSourceIds(conflict.conflictingSourceIds, context.allowedSourceIds, ctx, [
        'conflicts',
        index,
        'conflictingSourceIds',
      ]);
    });

    if (value.insufficientEvidence && value.confidence > 0.5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confidence'],
        message: '證據不足卻給出高信心是矛盾的',
      });
    }
    if (value.insufficientEvidence && !value.requiresHumanReview) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiresHumanReview'],
        message: '證據不足時必須標記需要人工審核',
      });
    }
    if (context.isSingleChoice && value.recommendedAnswer.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recommendedAnswer'],
        message: '單選題不可推薦多個答案',
      });
    }

    const unknownKeys = value.recommendedAnswer.filter((key) => !context.optionKeys.has(key));
    if (unknownKeys.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recommendedAnswer'],
        message: `推薦了不存在的選項：${unknownKeys.join('、')}`,
      });
    }
  });
}

// ------------------------------------------------------------ ③ 最終解析

const finalExplanationBase = z
  .object({
    answerValidation: z
      .object({
        agreesWithStoredAnswer: z.boolean(),
        verifiedAnswers: z.array(aiOptionKeySchema),
        conflictReason: z.string().max(1000).nullable(),
        confidence: confidenceSchema,
      })
      .strict(),

    explanation: z
      .object({
        coreConcept: z.string().min(1).max(1000),
        solutionSteps: z.array(z.string().min(1).max(500)).min(1).max(8),
        summary: z.string().min(1).max(2000),
      })
      .strict(),

    optionAnalysis: z
      .array(
        z
          .object({
            key: aiOptionKeySchema,
            isCorrect: z.boolean(),
            reason: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .min(2),

    mistakeAnalysis: z
      .object({
        userWasCorrect: z.boolean(),
        whyUserMightBeWrong: z.string().max(1500).nullable(),
        missedConditions: z.array(z.string().max(500)).max(5),
        /** 必須是既有錯誤類型的 code。 */
        errorTypeCode: z.string().min(1),
        /** 必須是既有知識點的名稱（經別名正規化後比對）。 */
        primaryKnowledgeTag: z.string().min(1),
        secondaryKnowledgeTags: z.array(z.string()).max(2),
        skillTag: z.string().nullable(),
        reviewSuggestions: z.array(z.string().max(500)).min(1).max(5),
        /** 只能「建議」，不能建立。一律進 tag_suggestions 等人工審核。 */
        suggestedNewTags: z
          .array(
            z
              .object({
                kind: z.enum(['knowledge', 'skill', 'error_type']),
                name: z.string().min(1).max(100),
                rationale: z.string().max(500),
              })
              .strict(),
          )
          .max(3),
      })
      .strict(),

    citations: z.array(citationSchema).max(10),
    confidence: confidenceSchema,
    requiresHumanReview: z.boolean(),
  })
  .strict();

export const finalExplanationSchema = finalExplanationBase;
export type FinalExplanation = z.infer<typeof finalExplanationBase>;

export interface FinalExplanationContext {
  allowedSourceIds: ReadonlySet<string>;
  /** 該題所有選項代號，順序無關。 */
  optionKeys: ReadonlySet<string>;
  /** 目前啟用的錯誤類型 code。 */
  allowedErrorTypeCodes: ReadonlySet<string>;
  /** fallback 錯誤類型的 code（「無法判定」）。 */
  fallbackErrorTypeCode: string;
  researchMode: z.infer<typeof researchModeSchema>;
}

export function buildFinalExplanationSchema(context: FinalExplanationContext) {
  return finalExplanationBase.superRefine((value, ctx) => {
    // 每個選項都要被解釋，且不得憑空生出選項。
    const analysed = new Set(value.optionAnalysis.map((item) => item.key));
    const missing = [...context.optionKeys].filter((key) => !analysed.has(key));
    const extra = [...analysed].filter((key) => !context.optionKeys.has(key));
    if (missing.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['optionAnalysis'],
        message: `漏了選項 ${missing.join('、')} 的分析`,
      });
    }
    if (extra.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['optionAnalysis'],
        message: `分析了不存在的選項 ${extra.join('、')}`,
      });
    }

    // 內部一致性：說哪些選項對，就要跟 verifiedAnswers 對得上。
    const markedCorrect = value.optionAnalysis
      .filter((item) => item.isCorrect)
      .map((item) => item.key)
      .sort();
    const verified = [...value.answerValidation.verifiedAnswers].sort();
    if (JSON.stringify(markedCorrect) !== JSON.stringify(verified)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['answerValidation', 'verifiedAnswers'],
        message: `verifiedAnswers（${verified.join('、')}）與 optionAnalysis 標為正確的選項（${markedCorrect.join('、')}）不一致`,
      });
    }

    if (!value.answerValidation.agreesWithStoredAnswer) {
      if (value.answerValidation.conflictReason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['answerValidation', 'conflictReason'],
          message: '質疑題庫答案時必須說明理由',
        });
      }
      if (!value.requiresHumanReview) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requiresHumanReview'],
          message: '質疑題庫答案時必須標記需要人工審核',
        });
      }
    }

    if (!value.mistakeAnalysis.userWasCorrect && value.mistakeAnalysis.whyUserMightBeWrong === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mistakeAnalysis', 'whyUserMightBeWrong'],
        message: '使用者答錯時必須說明可能的錯因',
      });
    }

    // 答對卻硬套一個具體錯誤類型是沒有根據的診斷。
    if (
      value.mistakeAnalysis.userWasCorrect &&
      value.mistakeAnalysis.errorTypeCode !== context.fallbackErrorTypeCode
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mistakeAnalysis', 'errorTypeCode'],
        message: `使用者答對時錯誤類型必須是「${context.fallbackErrorTypeCode}」`,
      });
    }

    if (!context.allowedErrorTypeCodes.has(value.mistakeAnalysis.errorTypeCode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mistakeAnalysis', 'errorTypeCode'],
        message: `錯誤類型「${value.mistakeAnalysis.errorTypeCode}」不在允許清單中`,
      });
    }

    if (
      value.mistakeAnalysis.secondaryKnowledgeTags.includes(
        value.mistakeAnalysis.primaryKnowledgeTag,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mistakeAnalysis', 'secondaryKnowledgeTags'],
        message: '次要知識點不可與主要知識點相同',
      });
    }

    refineSourceIds(
      value.citations.map((citation) => citation.sourceId),
      context.allowedSourceIds,
      ctx,
      ['citations'],
    );

    // 沒查資料就不可能有引用。
    if (context.researchMode === 'MODEL_ONLY' && value.citations.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['citations'],
        message: 'MODEL_ONLY 模式不應有任何引用',
      });
    }
  });
}
