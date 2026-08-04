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

/** 程式指派給模型的證據來源。模型只能引用這裡的 sourceId。 */
export interface EvidenceSource {
  sourceId: string;
  url: string;
  domain: string;
  title: string;
  publishedDate: string | null;
  fetchedAt: string;
  trustTier: TrustTier;
  content: string;
  searchQuery: string;
  rank: number;
  score: number;
}

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

/** 引用中允許的省略記號。用它串接同一份文件的不連續片段是正當的引用寫法。 */
const ELLIPSIS = /\.{3,}|[…⋯]+/;

/**
 * 比對前的正規化：只去掉空白。
 *
 * 不做標點或全半形轉換——那會讓「逐字」失去意義，
 * 而寬鬆的比對正是這個檢查要防的東西。
 */
function normalizeForQuoteMatch(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * 檢查引用的原文是否真的出現在該來源中。
 *
 * `refineSourceIds` 只驗證 sourceId **存在**，擋不住「指向一份真實的官方文件，
 * 然後編造它說過的話」。這是實際發生過的事：某次解析對一份財政部 PDF 捏造了
 * 一段逐字引用，內容裡的稅率換算還是錯的，而所有既有驗證全數通過。
 *
 * 失敗時的訊息會明白告知 quote 可以填 null——模型有這條合法退路，
 * 重生才不會必然耗盡次數而讓整次分析失敗。
 */
export function refineCitationQuotes(
  citations: readonly { sourceId: string; quote: string | null }[],
  contents: ReadonlyMap<string, string>,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  citations.forEach((citation, index) => {
    if (citation.quote === null) return;

    const content = contents.get(citation.sourceId);
    // sourceId 本身不合法時由 refineSourceIds 回報，這裡不重複噪音。
    if (content === undefined) return;

    const haystack = normalizeForQuoteMatch(content);
    const fragments = citation.quote
      .split(ELLIPSIS)
      .map(normalizeForQuoteMatch)
      .filter((fragment) => fragment.length > 0);
    if (fragments.length === 0) return;

    const missing = fragments.find((fragment) => !haystack.includes(fragment));
    if (missing === undefined) return;

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path, index, 'quote'],
      message:
        `引用的內容並未出現在來源 ${citation.sourceId} 中：「${missing.slice(0, 60)}」。` +
        'quote 必須逐字取自該來源正文（可用「…」串接不連續片段）；' +
        '無法逐字引用時請把 quote 填 null，不要改寫或自行補述。',
    });
  });
}
