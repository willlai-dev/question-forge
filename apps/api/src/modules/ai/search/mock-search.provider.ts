import { Injectable } from '@nestjs/common';

import type { ExtractedDocument, SearchHit, SearchProvider } from './search-provider';

/**
 * 測試與開發用的搜尋 provider。
 *
 * 回傳固定且合法的結果，讓三階段流程能在不消耗 Tavily 額度、
 * 也不依賴網路的情況下端到端跑通。
 *
 * 刻意包含一筆**會被 SSRF 檢查擋下**的結果，
 * 讓端到端測試能證明過濾確實有作用，而不只是「程式裡有那段」。
 */
@Injectable()
export class MockSearchProvider implements SearchProvider {
  readonly name = 'mock';

  async search(query: string, options: { maxResults: number }): Promise<SearchHit[]> {
    const hits: SearchHit[] = [
      {
        url: 'https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=mock-001',
        title: '（模擬）全國法規資料庫：相關條文',
        snippet: '（模擬）本條規定之要件包括……',
        score: 0.95,
        rank: 1,
        publishedDate: '2025-01-01',
        query,
      },
      {
        url: 'https://zh.wikipedia.org/wiki/mock-topic',
        title: '（模擬）維基百科：概念說明',
        snippet: '（模擬）該概念指的是……',
        score: 0.82,
        rank: 2,
        publishedDate: null,
        query,
      },
      {
        url: 'https://example.edu.tw/course/mock-notes',
        title: '（模擬）大學課程講義',
        snippet: '（模擬）授課筆記中對此的整理……',
        score: 0.71,
        rank: 3,
        publishedDate: null,
        query,
      },
      {
        // 這一筆應該被 URL 檢查擋下，永遠不會進入證據集合。
        url: 'http://169.254.169.254/latest/meta-data/',
        title: '（模擬）不應該被採用的內部位址',
        snippet: '（模擬）如果這筆出現在證據中，代表 SSRF 過濾失效。',
        score: 0.99,
        rank: 4,
        publishedDate: null,
        query,
      },
    ];

    return hits.slice(0, options.maxResults);
  }

  async extract(urls: string[]): Promise<ExtractedDocument[]> {
    return urls.map((url) => ({
      url,
      title: null,
      // 長度必須超過過濾門檻（200 字元），否則會被當成擷取失敗而剔除。
      content: `（模擬正文）${url}\n\n`.padEnd(600, '這是模擬的頁面正文內容，用於讓證據整理階段有東西可以引用。'),
      publishedDate: null,
    }));
  }
}
