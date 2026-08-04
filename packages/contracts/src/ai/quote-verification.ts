/**
 * 引用原文查核。
 *
 * 目標只有一個：**AI 不能把來源沒說過的話算在該來源頭上。**
 * 不是排版忠實度——因此比對前會把不影響語意的差異正規化掉。
 *
 * 這條界線是實測畫出來的。第一版做逐位元組比對（只去空白），
 * 在真實網頁上大量誤殺：Tavily 回傳的是 **markdown**，來源長這樣
 *
 *   The median expense ratio ... lower than that of [index mutual funds](/us/en/...), historically 0.56%
 *
 * 模型忠實引用時會寫成「...lower than that of index mutual funds, historically 0.56%」——
 * 丟掉連結語法。那是正確的引用，卻被判成捏造。任何長引用碰到真實網頁都會中招。
 *
 * 正規化掉 markdown 標記、彎引號與破折號、大小寫之後，保留的仍然是
 * 「這些字、以這個順序、確實出現在該來源」——捏造擋得住，忠實引用過得去。
 */

/** 一則待查核的引用。 */
export interface VerifiableCitation {
  sourceId: string;
  quote: string | null;
}

/** 查核不通過的引用。 */
export interface UnverifiedCitation {
  /** 在 citations 陣列中的位置。 */
  index: number;
  sourceId: string;
  /** 對不上的那一段（正規化後），供記錄與診斷。 */
  fragment: string;
}

/** 引用中允許的省略記號。用它串接同一份文件的不連續片段是正當寫法。 */
const ELLIPSIS = /\.{3,}|[…⋯]+/;

/**
 * 比對用的正規化。
 *
 * 順序有意義：先還原 markdown，再統一標點，最後才去空白與大小寫。
 * 反過來做的話，連結語法裡的括號會先被壓掉而無法辨識。
 */
export function normalizeForQuoteMatch(text: string): string {
  return (
    text
      // [顯示文字](網址) → 顯示文字。模型引用時幾乎一定會這樣還原。
      // 開頭的 `!` 可選，讓圖片語法 ![替代文字](網址) 走同一條規則——
      // 分成兩條的話，順序寫錯就會留下一個孤兒 `!`。
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      // 強調、行內程式碼、標題與引言記號
      .replace(/[*_`~#>|]/g, '')
      // 彎引號與各種破折號統一成 ASCII：模型輸出常常會換成直引號
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/[‐-―−－]/g, '-')
      // 最後才壓掉空白與大小寫。
      // 不需要另外列舉——列舉反而會在原始碼裡留下看不見的字元。
      .replace(/\s+/g, '')
      .toLowerCase()
  );
}

/**
 * 查核每一則引用是否真的出自它指名的來源。
 *
 * `quote` 為 null 直接通過——那是模型「無法逐字引用」時的合法選擇。
 * 來源不在 `contents` 中的也略過：那是 sourceId 本身不合法，
 * 由 `refineSourceIds` 負責回報，這裡不重複噪音。
 */
export function verifyCitationQuotes(
  citations: readonly VerifiableCitation[],
  contents: ReadonlyMap<string, string>,
): UnverifiedCitation[] {
  const unverified: UnverifiedCitation[] = [];

  // 同一份來源可能被多則引用指到，正規化一次就好。
  const normalizedContents = new Map<string, string>();
  const contentFor = (sourceId: string): string | undefined => {
    if (normalizedContents.has(sourceId)) return normalizedContents.get(sourceId);
    const raw = contents.get(sourceId);
    if (raw === undefined) return undefined;
    const normalized = normalizeForQuoteMatch(raw);
    normalizedContents.set(sourceId, normalized);
    return normalized;
  };

  citations.forEach((citation, index) => {
    if (citation.quote === null) return;

    const haystack = contentFor(citation.sourceId);
    if (haystack === undefined) return;

    const fragments = citation.quote
      .split(ELLIPSIS)
      .map(normalizeForQuoteMatch)
      .filter((fragment) => fragment.length > 0);
    if (fragments.length === 0) return;

    const missing = fragments.find((fragment) => !haystack.includes(fragment));
    if (missing === undefined) return;

    unverified.push({ index, sourceId: citation.sourceId, fragment: missing });
  });

  return unverified;
}
