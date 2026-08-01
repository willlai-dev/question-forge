import { describe, expect, it } from 'vitest';

import {
  buildEvidenceSynthesisSchema,
  buildFinalExplanationSchema,
  researchPlanSchema,
} from './schemas';

/**
 * AI 輸出的語意驗證。
 *
 * 這組測試存在的理由是規劃階段的實測結果：
 * NVIDIA 的 `json_schema` + `strict` 會保證**結構**正確，但不保證**語意**正確。
 * 實測到模型輸出過 `{ needsExternalSearch: true, researchMode: "MODEL_ONLY" }` ——
 * 完全符合 schema，語意卻自相矛盾。
 *
 * 每一條規則都對應一種「結構合法但不能採用」的輸出。
 */

const validPlan = {
  needsExternalSearch: true,
  researchMode: 'WEB_RESEARCH' as const,
  reason: '涉及具體法條，需要查證。',
  queries: ['行政處分 定義'],
  preferredDomains: ['law.moj.gov.tw'],
  preferredSourceTypes: ['official' as const],
  freshnessRequired: false,
  keyClaimsToVerify: ['行政處分的要件'],
};

describe('researchPlanSchema 語意驗證', () => {
  it('合法的規劃可以通過', () => {
    expect(researchPlanSchema.safeParse(validPlan).success).toBe(true);
  });

  it('說要搜尋卻選 MODEL_ONLY → 擋下（實測踩過的矛盾）', () => {
    const result = researchPlanSchema.safeParse({
      ...validPlan,
      researchMode: 'MODEL_ONLY',
      queries: [],
    });
    expect(result.success).toBe(false);
  });

  it('說不搜尋卻選 WEB_RESEARCH → 擋下', () => {
    const result = researchPlanSchema.safeParse({
      ...validPlan,
      needsExternalSearch: false,
      keyClaimsToVerify: [],
    });
    expect(result.success).toBe(false);
  });

  it('要做網路研究卻沒給查詢關鍵字 → 擋下', () => {
    const result = researchPlanSchema.safeParse({ ...validPlan, queries: [] });
    expect(result.success).toBe(false);
  });

  it('MODEL_ONLY 卻給了查詢關鍵字 → 擋下', () => {
    const result = researchPlanSchema.safeParse({
      ...validPlan,
      needsExternalSearch: false,
      researchMode: 'MODEL_ONLY',
      keyClaimsToVerify: [],
    });
    expect(result.success).toBe(false);
  });

  it('要查證卻沒說要查什麼 → 擋下', () => {
    const result = researchPlanSchema.safeParse({ ...validPlan, keyClaimsToVerify: [] });
    expect(result.success).toBe(false);
  });

  it('查詢超過 3 組 → 擋下（規格上限）', () => {
    const result = researchPlanSchema.safeParse({ ...validPlan, queries: ['a', 'b', 'c', 'd'] });
    expect(result.success).toBe(false);
  });

  it('不接受多餘欄位', () => {
    const result = researchPlanSchema.safeParse({ ...validPlan, extraField: 'x' });
    expect(result.success).toBe(false);
  });
});

describe('evidenceSynthesisSchema 語意驗證', () => {
  const schema = buildEvidenceSynthesisSchema({
    allowedSourceIds: new Set(['S1', 'S2']),
    optionKeys: new Set(['A', 'B', 'C']),
    isSingleChoice: true,
  });

  const valid = {
    evidenceSummary: '來源支持題庫答案。',
    supportedClaims: [{ claim: '答案為 A', sourceIds: ['S1'], strength: 'strong' as const }],
    contradictedClaims: [],
    conflicts: [],
    insufficientEvidence: false,
    recommendedAnswer: ['A'],
    confidence: 0.9,
    requiresHumanReview: false,
  };

  it('合法輸出可以通過', () => {
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it('**引用不存在的來源 → 擋下**（驗收標準 #16）', () => {
    const result = schema.safeParse({
      ...valid,
      supportedClaims: [{ claim: 'x', sourceIds: ['S9'], strength: 'strong' }],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('S9');
  });

  it('矛盾論點引用不存在的來源也會被擋下', () => {
    const result = schema.safeParse({
      ...valid,
      contradictedClaims: [{ claim: 'x', sourceIds: ['S99'], explanation: 'y' }],
    });
    expect(result.success).toBe(false);
  });

  it('證據不足卻給高信心 → 擋下', () => {
    const result = schema.safeParse({
      ...valid,
      insufficientEvidence: true,
      confidence: 0.9,
      requiresHumanReview: true,
    });
    expect(result.success).toBe(false);
  });

  it('證據不足卻不需人工審核 → 擋下', () => {
    const result = schema.safeParse({
      ...valid,
      insufficientEvidence: true,
      confidence: 0.3,
      requiresHumanReview: false,
    });
    expect(result.success).toBe(false);
  });

  it('單選題推薦多個答案 → 擋下', () => {
    const result = schema.safeParse({ ...valid, recommendedAnswer: ['A', 'B'] });
    expect(result.success).toBe(false);
  });

  it('推薦不存在的選項 → 擋下', () => {
    const result = schema.safeParse({ ...valid, recommendedAnswer: ['Z'] });
    expect(result.success).toBe(false);
  });

  it('衝突只有一方 → 擋下（衝突至少要有兩方）', () => {
    const result = schema.safeParse({
      ...valid,
      conflicts: [{ description: 'x', conflictingSourceIds: ['S1'] }],
    });
    expect(result.success).toBe(false);
  });
});

describe('finalExplanationSchema 語意驗證', () => {
  const context = {
    allowedSourceIds: new Set(['S1']),
    optionKeys: new Set(['A', 'B', 'C']),
    allowedErrorTypeCodes: new Set(['concept_confusion', 'undetermined']),
    fallbackErrorTypeCode: 'undetermined',
    researchMode: 'WEB_RESEARCH' as const,
  };
  const schema = buildFinalExplanationSchema(context);

  const valid = {
    answerValidation: {
      agreesWithStoredAnswer: true,
      verifiedAnswers: ['A'],
      conflictReason: null,
      confidence: 0.9,
    },
    explanation: { coreConcept: '概念', solutionSteps: ['步驟一'], summary: '總結' },
    optionAnalysis: [
      { key: 'A', isCorrect: true, reason: '正確' },
      { key: 'B', isCorrect: false, reason: '錯誤' },
      { key: 'C', isCorrect: false, reason: '錯誤' },
    ],
    mistakeAnalysis: {
      userWasCorrect: false,
      whyUserMightBeWrong: '把兩個概念搞混',
      missedConditions: [],
      errorTypeCode: 'concept_confusion',
      primaryKnowledgeTag: '行政處分',
      secondaryKnowledgeTags: [],
      skillTag: null,
      reviewSuggestions: ['複習定義'],
      suggestedNewTags: [],
    },
    citations: [{ sourceId: 'S1', quote: null, relevance: 'direct' as const }],
    confidence: 0.9,
    requiresHumanReview: false,
  };

  it('合法輸出可以通過', () => {
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it('漏了某個選項的分析 → 擋下', () => {
    const result = schema.safeParse({
      ...valid,
      optionAnalysis: valid.optionAnalysis.slice(0, 2),
    });
    expect(result.success).toBe(false);
  });

  it('分析了不存在的選項 → 擋下', () => {
    const result = schema.safeParse({
      ...valid,
      optionAnalysis: [...valid.optionAnalysis, { key: 'Z', isCorrect: false, reason: 'x' }],
    });
    expect(result.success).toBe(false);
  });

  it('標為正確的選項與 verifiedAnswers 不一致 → 擋下', () => {
    const result = schema.safeParse({
      ...valid,
      answerValidation: { ...valid.answerValidation, verifiedAnswers: ['B'] },
    });
    expect(result.success).toBe(false);
  });

  it('質疑題庫答案卻沒說理由 → 擋下', () => {
    const result = schema.safeParse({
      ...valid,
      answerValidation: { ...valid.answerValidation, agreesWithStoredAnswer: false },
      requiresHumanReview: true,
    });
    expect(result.success).toBe(false);
  });

  it('質疑題庫答案卻不需人工審核 → 擋下', () => {
    const result = schema.safeParse({
      ...valid,
      answerValidation: {
        ...valid.answerValidation,
        agreesWithStoredAnswer: false,
        conflictReason: '條文已修正',
      },
      requiresHumanReview: false,
    });
    expect(result.success).toBe(false);
  });

  it('使用者答錯卻沒有錯因說明 → 擋下', () => {
    const result = schema.safeParse({
      ...valid,
      mistakeAnalysis: { ...valid.mistakeAnalysis, whyUserMightBeWrong: null },
    });
    expect(result.success).toBe(false);
  });

  it('使用者答對卻套用具體錯誤類型 → 擋下', () => {
    const result = schema.safeParse({
      ...valid,
      mistakeAnalysis: {
        ...valid.mistakeAnalysis,
        userWasCorrect: true,
        whyUserMightBeWrong: null,
        errorTypeCode: 'concept_confusion',
      },
    });
    expect(result.success).toBe(false);
  });

  it('使用者答對且用 fallback 錯誤類型 → 通過', () => {
    const result = schema.safeParse({
      ...valid,
      mistakeAnalysis: {
        ...valid.mistakeAnalysis,
        userWasCorrect: true,
        whyUserMightBeWrong: null,
        errorTypeCode: 'undetermined',
      },
    });
    expect(result.success).toBe(true);
  });

  it('**自創錯誤類型 → 擋下**（AI 不得繞過受控詞彙）', () => {
    const result = schema.safeParse({
      ...valid,
      mistakeAnalysis: { ...valid.mistakeAnalysis, errorTypeCode: '粗心大意' },
    });
    expect(result.success).toBe(false);
  });

  it('次要知識點與主要重複 → 擋下', () => {
    const result = schema.safeParse({
      ...valid,
      mistakeAnalysis: {
        ...valid.mistakeAnalysis,
        secondaryKnowledgeTags: ['行政處分'],
      },
    });
    expect(result.success).toBe(false);
  });

  it('**引用不存在的來源 → 擋下**（驗收標準 #16）', () => {
    const result = schema.safeParse({
      ...valid,
      citations: [{ sourceId: 'S404', quote: null, relevance: 'direct' }],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('S404');
  });

  it('MODEL_ONLY 模式卻有引用 → 擋下（沒查資料就不該有來源）', () => {
    const modelOnly = buildFinalExplanationSchema({ ...context, researchMode: 'MODEL_ONLY' });
    const result = modelOnly.safeParse(valid);
    expect(result.success).toBe(false);
  });

  it('MODEL_ONLY 模式且沒有引用 → 通過', () => {
    const modelOnly = buildFinalExplanationSchema({ ...context, researchMode: 'MODEL_ONLY' });
    const result = modelOnly.safeParse({ ...valid, citations: [] });
    expect(result.success).toBe(true);
  });
});
