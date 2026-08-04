import { z } from 'zod';

/**
 * AI 輸入輸出的共用型別（docs/AI_ANALYSIS_SCHEMAS.md §0）。
 *
 * 驗證分四層，缺一不可：
 *   ① NVIDIA 的 `json_schema` + `strict` —— 結構由 API 保證
 *   ② 這裡的 Zod schema —— 型別與範圍再確認（防 provider 行為改變）
 *   ③ superRefine 語意驗證 —— 跨欄位一致性
 *   ④ 參照完整性檢查 —— sourceId / tagId 必須真實存在
 *
 * 第 ③ 層是規劃階段實測踩出來的：`reasoning_effort: "none"` 時模型輸出過
 * `{ needsExternalSearch: true, researchMode: "MODEL_ONLY" }` ——
 * 完全符合 schema，語意卻自相矛盾。**結構合法不等於語意正確。**
 */

export const confidenceSchema = z.number().min(0).max(1);

export const researchModeSchema = z.enum([
  'MODEL_ONLY',
  'PDF_KNOWLEDGE',
  'WEB_RESEARCH',
  'HYBRID',
]);
export type ResearchMode = z.infer<typeof researchModeSchema>;

/** 需要實際上網查證的模式。 */
export const WEB_RESEARCH_MODES: readonly ResearchMode[] = ['WEB_RESEARCH', 'HYBRID'];

export const aiOptionKeySchema = z.string().regex(/^[A-Z]$/, '選項代號必須是單一大寫英文字母');

export const citationSchema = z.object({
  /** 必須存在於本次證據集合，由程式驗證（驗收標準 #16）。 */
  sourceId: z.string().min(1),
  /**
   * 用 nullable 而非 optional：NVIDIA 的 `strict: true` 要求所有屬性都列在 `required`，
   * optional 欄位會讓產生的 JSON Schema 不符合該限制而被 400 拒絕（實測結論）。
   */
  quote: z.string().max(500).nullable(),
  relevance: z.enum(['direct', 'supporting', 'background']),
});
export type Citation = z.infer<typeof citationSchema>;

export const trustTierSchema = z.enum([
  'official',
  'academic',
  'educational',
  'reference',
  'other',
]);
export type TrustTier = z.infer<typeof trustTierSchema>;

/** trustTier 的排序權重，數字小的優先。 */
export const TRUST_TIER_RANK: Record<TrustTier, number> = {
  official: 0,
  academic: 1,
  educational: 2,
  reference: 3,
  other: 4,
};

/**
 * 一次分析中送進模型的單一來源。
 *
 * 兩種來源共用這個型別（也共用同一張資料表）：網頁與使用者匯入的章節筆記。
 * 共用的理由是引用驗證只能有一套——「citations ⊆ 本次來源」與
 * 「quote 必須逐字出自來源」對兩者一體適用。分成兩套遲早會分岔，
 * 而分岔的後果是 AI 可以捏造筆記內容。
 */
export interface EvidenceSource {
  sourceId: string;
  sourceType: EvidenceSourceType;
  /** 筆記沒有 URL 與網域。 */
  url: string | null;
  domain: string | null;
  title: string;
  publishedDate: string | null;
  fetchedAt: string;
  trustTier: TrustTier;
  content: string;
  /** 筆記不是查來的，因此沒有查詢字串與搜尋排名。 */
  searchQuery: string | null;
  rank: number | null;
  score: number | null;
  /** 筆記來源指回 study_notes，供追溯是哪一段筆記。 */
  studyNoteId: string | null;
}

export const evidenceSourceTypeSchema = z.enum(['web', 'note']);
export type EvidenceSourceType = z.infer<typeof evidenceSourceTypeSchema>;

/** AI 呼叫的三個階段。 */
export const aiOperationSchema = z.enum([
  'research_plan',
  'evidence_synthesis',
  'final_explanation',
  'aggregate_analysis',
]);
export type AiOperation = z.infer<typeof aiOperationSchema>;

/**
 * 在 superRefine 中檢查 sourceId 是否都存在於允許清單。
 *
 * 之所以做成共用函式：三個階段都要檢查同一件事，
 * 分散實作遲早會有一處漏掉，而漏掉的後果是 AI 可以憑空捏造來源。
 */
export function refineSourceIds(
  sourceIds: readonly string[],
  allowed: ReadonlySet<string>,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  const unknown = sourceIds.filter((id) => !allowed.has(id));
  if (unknown.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `引用了不存在的來源：${unknown.join('、')}`,
    });
  }
}

