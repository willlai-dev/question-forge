import { Inject, Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES, type Env } from '@repo/contracts';

import { AppException } from '../../../common/app.exception';
import { ENV } from '../../../config/env.config';
import type { ExtractedDocument, SearchHit, SearchProvider } from './search-provider';

/**
 * Tavily 搜尋 provider。
 *
 * 選 Tavily 而非 Brave 的理由（SYSTEM_DESIGN 決策 #2）：
 * Tavily 同時提供 `/search` 與 first-party 的 `/extract`，
 * 後者直接回傳乾淨的 markdown 正文。若只有搜尋結果就得自己抓網頁、
 * 自己清 HTML／script／廣告，那等於把 SSRF 與正文清洗的攻擊面整個攬進來。
 *
 * 規劃階段已實測兩個端點皆可用，且 `/extract` 會另外回報 `failed_results`。
 */
@Injectable()
export class TavilySearchProvider implements SearchProvider {
  readonly name = 'tavily';
  private readonly logger = new Logger(TavilySearchProvider.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  async search(query: string, options: { maxResults: number }): Promise<SearchHit[]> {
    const payload = await this.post('/search', {
      query,
      search_depth: this.env.TAVILY_SEARCH_DEPTH,
      max_results: options.maxResults,
    });

    const results = (payload as { results?: unknown[] }).results ?? [];
    return results.map((raw, index) => {
      const item = raw as {
        url?: string;
        title?: string;
        content?: string;
        score?: number;
        published_date?: string;
      };
      return {
        url: item.url ?? '',
        title: item.title ?? '(無標題)',
        snippet: item.content ?? '',
        score: item.score ?? 0,
        rank: index + 1,
        publishedDate: item.published_date ?? null,
        query,
      };
    });
  }

  async extract(urls: string[]): Promise<ExtractedDocument[]> {
    if (urls.length === 0) return [];

    const payload = await this.post('/extract', { urls });
    const results = (payload as { results?: unknown[]; failed_results?: unknown[] }).results ?? [];
    const failed = (payload as { failed_results?: unknown[] }).failed_results ?? [];

    if (failed.length > 0) {
      // 擷取失敗是常態（付費牆、反爬蟲），記錄數量即可，不視為錯誤。
      this.logger.log(`Tavily extract：${results.length} 筆成功、${failed.length} 筆失敗`);
    }

    return results.map((raw) => {
      const item = raw as { url?: string; raw_content?: string; title?: string };
      return {
        url: item.url ?? '',
        title: item.title ?? null,
        content: item.raw_content ?? '',
        publishedDate: null,
      };
    });
  }

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(`${this.env.TAVILY_API_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.env.TAVILY_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 200);
        this.logger.warn(`Tavily ${path} 回應 ${response.status}：${detail}`);
        throw new AppException(
          ERROR_CODES.SEARCH_PROVIDER_UNAVAILABLE,
          `搜尋服務暫時無法使用（${response.status}）。`,
        );
      }

      return await response.json();
    } catch (error) {
      if (error instanceof AppException) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AppException(ERROR_CODES.SEARCH_PROVIDER_UNAVAILABLE, '搜尋服務回應逾時。');
      }
      throw new AppException(
        ERROR_CODES.SEARCH_PROVIDER_UNAVAILABLE,
        `無法連線至搜尋服務：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
