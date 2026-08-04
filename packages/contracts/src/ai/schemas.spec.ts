import { describe, expect, it } from 'vitest';

import {
  buildAggregateAnalysisSchema,
  buildEvidenceSynthesisSchema,
  buildFinalExplanationSchema,
  buildResearchPlanSchema,
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
    evidenceConfidence: 0.95,
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
      { key: 'A', isCorrect: true, reason: '符合題目所述的全部要件，逐項對得上。' },
      { key: 'B', isCorrect: false, reason: '缺少法定的書面通知要件，因此不成立。' },
      { key: 'C', isCorrect: false, reason: '屬於行政計畫，適用的是另一套程序規定。' },
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

  // 逐選項說明的下限。
  //
  // 起因：使用者反映答對的題目，錯誤選項只被一句話帶過。1.0.0 的 prompt
  // 開頭就把任務框成「分析使用者為什麼答錯」，答對時模型自然會簡化。
  // 但答對只代表這次選對，不代表知道其他選項為什麼錯。

  it('**選項說明只給結論 → 擋下**', () => {
    const result = schema.safeParse({
      ...valid,
      optionAnalysis: [
        { key: 'A', isCorrect: true, reason: '這個選項完全符合題目所述的要件。' },
        { key: 'B', isCorrect: false, reason: '不正確' },
        { key: 'C', isCorrect: false, reason: '這個選項缺少法定的書面通知要件。' },
      ],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('判斷依據');
  });

  it('答對的情境下，錯誤選項的說明一樣要達標', () => {
    const result = schema.safeParse({
      ...valid,
      mistakeAnalysis: {
        ...valid.mistakeAnalysis,
        userWasCorrect: true,
        whyUserMightBeWrong: null,
        errorTypeCode: 'undetermined',
      },
      optionAnalysis: [
        { key: 'A', isCorrect: true, reason: '符合題目要求的全部三項要件，逐項對得上。' },
        { key: 'B', isCorrect: false, reason: '不符合' },
        { key: 'C', isCorrect: false, reason: '適用的是另一條規定，稅率並不相同。' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('寫出判斷依據的選項說明 → 通過', () => {
    const result = schema.safeParse({
      ...valid,
      optionAnalysis: [
        { key: 'A', isCorrect: true, reason: '符合題目要求的全部三項要件，逐項對得上。' },
        { key: 'B', isCorrect: false, reason: '缺少法定的書面通知要件，因此不成立。' },
        { key: 'C', isCorrect: false, reason: '適用的是另一條規定，容易與本題概念混淆。' },
      ],
    });
    expect(result.success).toBe(true);
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
      optionAnalysis: [
        ...valid.optionAnalysis,
        { key: 'Z', isCorrect: false, reason: '這個選項在題目中根本不存在。' },
      ],
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

  // --- 數字自相矛盾 ---

  it('**選項理由裡分數與百分比對不起來 → 擋下**', () => {
    const result = schema.safeParse({
      ...valid,
      optionAnalysis: [
        { key: 'A', isCorrect: true, reason: '稅率為契約金額的0.02%（10萬分之2）。' },
        { key: 'B', isCorrect: false, reason: '屬於權利金課徵，與本題的稅基不同。' },
        { key: 'C', isCorrect: false, reason: '屬於證券交易稅的範圍，不是期貨交易稅。' },
      ],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('自相矛盾');
  });

  it('換算正確的分數與百分比 → 通過', () => {
    const result = schema.safeParse({
      ...valid,
      optionAnalysis: [
        { key: 'A', isCorrect: true, reason: '稅率為契約金額的0.002%（10萬分之2）。' },
        { key: 'B', isCorrect: false, reason: '按權利金金額課徵千分之1，即0.1%。' },
        { key: 'C', isCorrect: false, reason: '屬於證券交易稅的範圍，不是期貨交易稅。' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('核心概念裡的矛盾也會被抓到（不是只看選項）', () => {
    const result = schema.safeParse({
      ...valid,
      explanation: { ...valid.explanation, coreConcept: '期貨交易稅為0.02%（十萬分之二）。' },
    });
    expect(result.success).toBe(false);
  });

  // --- 信心上限 ---
  //
  // 這裡**不再擋**。改由 QuestionAnalysisService 夾住：
  // 模型很愛給 1.0，一被退回就整段重生，而 final_explanation 一次要 84 秒。
  // 實際用量紀錄裡有 3 次重生純粹是為了把 1.0 改成 0.96 ——
  // 為了一個數字付掉一分半鐘。夾住是無損的：上限本來就來自同一次分析的證據階段。

  it('信心高於證據階段不再擋下（改由 service 夾住）', () => {
    expect(schema.safeParse({ ...valid, confidence: 1 }).success).toBe(true);
  });

  it('答案驗證信心高於證據階段也不再擋下', () => {
    const result = schema.safeParse({
      ...valid,
      answerValidation: { ...valid.answerValidation, confidence: 0.99 },
    });
    expect(result.success).toBe(true);
  });

  it('沒有任何來源時不套用信心上限', () => {
    // 證據階段在沒有來源時給的低信心講的是「沒有證據」，
    // 拿它當上限會把所有不需查證的題目一律壓到低分。
    const noEvidence = buildFinalExplanationSchema({
      ...context,
      researchMode: 'MODEL_ONLY',
      evidenceConfidence: null,
    });
    const result = noEvidence.safeParse({ ...valid, citations: [], confidence: 1 });
    expect(result.success).toBe(true);
  });
});

// ------------------------------------------------------------ ④ 多題整合分析

describe('buildAggregateAnalysisSchema', () => {
  const context = {
    allowedKnowledgeTagNames: new Set(['行政處分', '信賴保護原則']),
    allowedErrorTypeCodes: new Set(['concept_confusion', 'careless']),
    allowedPracticeRefIds: new Set(['q-1', 'g-1']),
  };

  const valid = {
    weakestKnowledgeTags: [
      { tagName: '行政處分', accuracy: 33.33, severity: 'high' as const, evidence: '10 題錯 7 題' },
    ],
    commonErrorTypes: [
      { errorTypeCode: 'concept_confusion', count: 5, interpretation: '概念界線不清' },
    ],
    errorPatterns: [
      {
        pattern: '例外規定總是答錯',
        relatedKnowledgeTags: ['行政處分'],
        relatedErrorTypes: ['concept_confusion'],
        explanation: '跨單元的共同弱點',
      },
    ],
    reviewPriority: [
      { rank: 1, target: '行政處分', reason: '正確率最低' },
      { rank: 2, target: '信賴保護原則', reason: '連續答錯' },
    ],
    recommendedPractice: [
      { kind: 'question' as const, refId: 'q-1', label: '第 1 題', reason: '反覆答錯' },
    ],
    improvement: {
      hasImproved: true,
      improvedAreas: ['信賴保護原則'],
      stagnantAreas: [],
      summary: '整體有進步',
    },
    learningSuggestions: ['先把定義背熟'],
    analysisBasis: '依據 14 筆作答的統計',
    confidence: 0.8,
  };

  it('合法輸出通過', () => {
    expect(buildAggregateAnalysisSchema(context).safeParse(valid).success).toBe(true);
  });

  it('**自創知識點名稱會被擋下**', () => {
    const result = buildAggregateAnalysisSchema(context).safeParse({
      ...valid,
      weakestKnowledgeTags: [
        { tagName: '我自己想的知識點', accuracy: 10, severity: 'critical', evidence: '' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('**自創錯誤類型代碼會被擋下**', () => {
    const result = buildAggregateAnalysisSchema(context).safeParse({
      ...valid,
      commonErrorTypes: [{ errorTypeCode: 'made_up', count: 1, interpretation: '' }],
    });
    expect(result.success).toBe(false);
  });

  it('**推薦不存在的複習目標會被擋下**（否則點下去是死連結）', () => {
    const result = buildAggregateAnalysisSchema(context).safeParse({
      ...valid,
      recommendedPractice: [
        { kind: 'question', refId: 'q-does-not-exist', label: 'x', reason: 'y' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('錯誤模式裡引用的知識點也要存在', () => {
    const result = buildAggregateAnalysisSchema(context).safeParse({
      ...valid,
      errorPatterns: [
        {
          pattern: 'x',
          relatedKnowledgeTags: ['不存在的'],
          relatedErrorTypes: ['concept_confusion'],
          explanation: 'y',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('優先順序重複會被擋下', () => {
    const result = buildAggregateAnalysisSchema(context).safeParse({
      ...valid,
      reviewPriority: [
        { rank: 1, target: 'a', reason: 'x' },
        { rank: 1, target: 'b', reason: 'y' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('優先順序不連續會被擋下（第 1、第 5 順位無法執行）', () => {
    const result = buildAggregateAnalysisSchema(context).safeParse({
      ...valid,
      reviewPriority: [
        { rank: 1, target: 'a', reason: 'x' },
        { rank: 5, target: 'b', reason: 'y' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('優先順序空陣列可接受', () => {
    const result = buildAggregateAnalysisSchema(context).safeParse({
      ...valid,
      reviewPriority: [],
    });
    expect(result.success).toBe(true);
  });

  it('說有改善卻列不出改善項目會被擋下', () => {
    const result = buildAggregateAnalysisSchema(context).safeParse({
      ...valid,
      improvement: { ...valid.improvement, hasImproved: true, improvedAreas: [] },
    });
    expect(result.success).toBe(false);
  });

  it('沒有改善時不需要列出改善項目', () => {
    const result = buildAggregateAnalysisSchema(context).safeParse({
      ...valid,
      improvement: { ...valid.improvement, hasImproved: false, improvedAreas: [] },
    });
    expect(result.success).toBe(true);
  });

  it('學習建議不可為空——空的診斷沒有價值', () => {
    const result = buildAggregateAnalysisSchema(context).safeParse({
      ...valid,
      learningSuggestions: [],
    });
    expect(result.success).toBe(false);
  });

  it('多出未定義的欄位會被擋下（strict）', () => {
    const result = buildAggregateAnalysisSchema(context).safeParse({
      ...valid,
      somethingExtra: 1,
    });
    expect(result.success).toBe(false);
  });
});

/**
 * 有無章節筆記時的 researchMode 規則。
 *
 * 關鍵在 MODEL_ONLY：該模式下最終解析的 citations 必須是空陣列。
 * 有筆記卻選 MODEL_ONLY，筆記雖然被送進脈絡卻一句都不能引用——
 * 整個功能等於沒有作用，而且失效時完全無聲。
 */
describe('buildResearchPlanSchema：章節筆記', () => {
  const plan = (over: Record<string, unknown> = {}) => ({
    needsExternalSearch: true,
    researchMode: 'WEB_RESEARCH',
    reason: '需要查證現行條文。',
    queries: ['查詢一'],
    preferredDomains: [],
    preferredSourceTypes: [],
    freshnessRequired: false,
    keyClaimsToVerify: ['要查證的論點'],
    ...over,
  });

  const withNotes = buildResearchPlanSchema({ hasNotes: true });
  const noNotes = buildResearchPlanSchema({ hasNotes: false });

  it('沒有筆記 + 上網查 → WEB_RESEARCH 通過', () => {
    expect(noNotes.safeParse(plan()).success).toBe(true);
  });

  it('**沒有筆記卻選 PDF_KNOWLEDGE → 擋下**（記錄下來的模式會是假的）', () => {
    const result = noNotes.safeParse(
      plan({ needsExternalSearch: false, researchMode: 'PDF_KNOWLEDGE', queries: [], keyClaimsToVerify: [] }),
    );
    expect(result.success).toBe(false);
  });

  it('**有筆記卻選 MODEL_ONLY → 擋下**（該模式禁止任何引用）', () => {
    const result = withNotes.safeParse(
      plan({ needsExternalSearch: false, researchMode: 'MODEL_ONLY', queries: [], keyClaimsToVerify: [] }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('禁止任何引用');
  });

  it('有筆記 + 上網查 → 必須是 HYBRID', () => {
    expect(withNotes.safeParse(plan({ researchMode: 'WEB_RESEARCH' })).success).toBe(false);
    expect(withNotes.safeParse(plan({ researchMode: 'HYBRID' })).success).toBe(true);
  });

  it('有筆記 + 不上網查 → PDF_KNOWLEDGE 通過', () => {
    const result = withNotes.safeParse(
      plan({ needsExternalSearch: false, researchMode: 'PDF_KNOWLEDGE', queries: [], keyClaimsToVerify: [] }),
    );
    expect(result.success).toBe(true);
  });
});
