import type { TrustTier } from '@repo/contracts';

/** 搜尋 provider 抽象（規格 §二要求「搜尋服務可替換」）。 */

export interface SearchHit {
  url: string;
  title: string;
  /** 搜尋引擎給的摘要，尚未取得完整正文。 */
  snippet: string;
  score: number;
  rank: number;
  publishedDate: string | null;
  query: string;
}

export interface ExtractedDocument {
  url: string;
  title: string | null;
  /** 乾淨的正文（Tavily 直接回傳 markdown，不含 HTML／script／廣告／導覽）。 */
  content: string;
  publishedDate: string | null;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, options: { maxResults: number }): Promise<SearchHit[]>;
  /** 批次取正文。失敗的 URL 直接略過，不讓單一頁面拖垮整批。 */
  extract(urls: string[]): Promise<ExtractedDocument[]>;
}

export const SEARCH_PROVIDER = Symbol('SEARCH_PROVIDER');

/**
 * 依網域判定可信度分層。
 *
 * 排序時 official > academic > educational > reference > other，
 * 讓有限的證據額度優先留給權威來源。
 */
export function classifyTrustTier(url: string): TrustTier {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return 'other';
  }

  // 政府與官方法規資料庫
  if (/(^|\.)gov(\.[a-z]{2})?$/.test(hostname)) return 'official';
  if (hostname.endsWith('.gov.tw') || hostname.endsWith('.gov')) return 'official';
  if (hostname.includes('law.moj.gov.tw') || hostname.includes('lawbank')) return 'official';
  if (hostname.endsWith('.judicial.gov.tw')) return 'official';

  // 學術機構
  if (/(^|\.)edu(\.[a-z]{2})?$/.test(hostname)) return 'academic';
  if (hostname.endsWith('.edu.tw') || hostname.endsWith('.ac.uk')) return 'academic';
  if (hostname.includes('scholar.google') || hostname.includes('jstor')) return 'academic';

  // 教學／百科
  if (hostname.endsWith('.org.tw') || hostname.endsWith('.org')) return 'educational';
  if (hostname.includes('wikipedia.org') || hostname.includes('wikibooks')) return 'reference';
  if (hostname.includes('investopedia') || hostname.includes('britannica')) return 'reference';

  return 'other';
}
