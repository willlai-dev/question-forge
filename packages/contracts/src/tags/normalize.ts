/**
 * 標籤名稱正規化。
 *
 * 規格 §8 的核心訴求是「標籤不得由 AI 自由生成，避免同義詞失控」。
 * 正規化是第一道防線：把只有寫法差異的名稱收斂成同一個鍵，
 * 讓「行政處分」與「行政 處分」、「ＡＢＣ」與「abc」不會變成兩個標籤。
 *
 * 刻意**不**處理的是錯字（例如「行政處份」）——
 * 那不是寫法差異而是不同字串，必須由 `tag_aliases` 明確登錄，
 * 否則正規化就得開始猜測使用者的意圖，那會製造更難查的錯誤。
 */

/**
 * 產生用於比對的正規化鍵。
 *
 * 步驟固定為三步，順序有意義：
 *   1. NFKC：全形英數與相容字元轉半形（Ａ→A、（→( ），必須在轉小寫之前做。
 *   2. 轉小寫：英文標籤大小寫不應區分。
 *   3. 去掉**所有**空白：中文詞彙中間的空白純屬輸入習慣，不帶語意。
 */
export function normalizeTagName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

/**
 * 產生標籤的 slug（用於唯一索引）。
 *
 * 與 `normalizeTagName` 使用同一套規則 —— 兩者若各自演進，
 * 就會出現「別名比對得到 A，但唯一索引擋的是 B」這種難以理解的狀況。
 */
export function toTagSlug(name: string): string {
  return normalizeTagName(name);
}

/** 名稱是否等價（正規化後相同）。 */
export function isSameTagName(a: string, b: string): boolean {
  return normalizeTagName(a) === normalizeTagName(b);
}
