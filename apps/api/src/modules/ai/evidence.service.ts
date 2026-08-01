import { Inject, Injectable, Logger } from '@nestjs/common';
import { TRUST_TIER_RANK, type Env, type EvidenceSource } from '@repo/contracts';
import { computeUrlHash, normalizeUrl } from '@repo/contracts/server';
import { schema, type Database, type DatabaseHandle } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';

import { ENV } from '../../config/env.config';
import { DATABASE } from '../../infra/infra.module';
import {
  classifyTrustTier,
  SEARCH_PROVIDER,
  type SearchHit,
  type SearchProvider,
} from './search/search-provider';
import { checkUrlSyntactically } from './search/url-guard';

/** 正文太短的頁面通常是導覽頁或擷取失敗，留著只會稀釋證據品質。 */
const MIN_CONTENT_CHARS = 200;

/**
 * 證據蒐集（規格 §9 的「程式搜尋與擷取」階段，**完全沒有 AI 參與**）。
 *
 * 這一步的產出決定了下一階段的輸入品質，也決定了 AI 能引用什麼。
 * `sourceId`（S1、S2…）由**程式**指派，模型只能引用這些 ID ——
 * 這是「AI 引用只能指向實際存在來源」（驗收標準 #16）的起點。
 */
@Injectable()
export class EvidenceService {
  private readonly logger = new Logger(EvidenceService.name);

  constructor(
    @Inject(SEARCH_PROVIDER) private readonly search: SearchProvider,
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get providerName(): string {
    return this.search.name;
  }

  /**
   * 執行查詢並組出證據集合。
   *
   * 步驟依規格 §9 逐條：搜尋 → 去重 → 依可信度排序 → 取正文 → 截斷 → 過濾 → 指派 sourceId。
   */
  async collect(queries: string[]): Promise<EvidenceSource[]> {
    const limitedQueries = queries.slice(0, this.env.TAVILY_MAX_QUERIES_PER_QUESTION);
    if (limitedQueries.length === 0) return [];

    const hits: SearchHit[] = [];
    for (const query of limitedQueries) {
      try {
        const found = await this.search.search(query, {
          maxResults: this.env.TAVILY_MAX_RESULTS_PER_QUERY,
        });
        hits.push(...found);
      } catch (error) {
        // 單一查詢失敗不該讓整個分析中止；少一組查詢只是證據少一些。
        this.logger.warn(`查詢「${query}」失敗，略過：${describe(error)}`);
      }
    }

    // ① SSRF 過濾。即使來源是搜尋服務也要檢查 ——
    //    搜尋結果可以被投毒，而我們接下來要把這些 URL 送去擷取。
    const safe = hits.filter((hit) => {
      const check = checkUrlSyntactically(hit.url);
      if (!check.allowed) {
        this.logger.warn(`搜尋結果被 URL 檢查擋下（${check.reason}）：${hit.url}`);
      }
      return check.allowed;
    });

    // ② 跨查詢去重，以正規化後的 URL 比對。
    const deduped = new Map<string, SearchHit>();
    for (const hit of safe) {
      const key = normalizeUrl(hit.url);
      const existing = deduped.get(key);
      if (!existing || hit.score > existing.score) deduped.set(key, hit);
    }

    // ③ 依可信度分層排序，同層再依分數。有限的額度優先留給權威來源。
    const ordered = [...deduped.values()].sort((a, b) => {
      const tierDiff = TRUST_TIER_RANK[classifyTrustTier(a.url)] - TRUST_TIER_RANK[classifyTrustTier(b.url)];
      return tierDiff !== 0 ? tierDiff : b.score - a.score;
    });

    // ④ 取正文：先查快取，只對沒有快取的 URL 呼叫擷取。
    const contents = await this.loadContents(ordered.map((hit) => hit.url));

    // ⑤ 截斷、過濾、指派 sourceId。
    const sources: EvidenceSource[] = [];
    let totalChars = 0;

    for (const hit of ordered) {
      const content = contents.get(normalizeUrl(hit.url));
      if (!content || content.length < MIN_CONTENT_CHARS) continue;

      const remaining = this.env.EVIDENCE_TOTAL_MAX_CHARS - totalChars;
      if (remaining <= MIN_CONTENT_CHARS) break;

      const truncated = content.slice(0, Math.min(this.env.EVIDENCE_SOURCE_MAX_CHARS, remaining));
      totalChars += truncated.length;

      sources.push({
        sourceId: `S${sources.length + 1}`,
        url: hit.url,
        domain: safeHostname(hit.url),
        title: hit.title,
        publishedDate: hit.publishedDate,
        fetchedAt: new Date().toISOString(),
        trustTier: classifyTrustTier(hit.url),
        content: truncated,
        searchQuery: hit.query,
        rank: hit.rank,
        score: hit.score,
      });
    }

    this.logger.log(
      `證據蒐集完成：查詢 ${limitedQueries.length} 組、命中 ${hits.length} 筆、去重後 ${ordered.length} 筆、採用 ${sources.length} 筆`,
    );
    return sources;
  }

  /**
   * 取得正文，優先使用 `web_documents` 的跨題快取。
   *
   * 快取放 PostgreSQL 而不是只放 Redis：規格要求永久資料不得只存在 Redis，
   * 而擷取結果是真的可以跨題重用的資產，不該隨 Redis 重啟而消失。
   */
  private async loadContents(urls: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (urls.length === 0) return result;

    const hashByUrl = new Map(urls.map((url) => [url, computeUrlHash(url)]));
    const hashes = [...hashByUrl.values()];

    const cached = await this.database.db
      .select({
        urlHash: schema.webDocuments.urlHash,
        url: schema.webDocuments.url,
        extractedText: schema.webDocuments.extractedText,
        expiresAt: schema.webDocuments.expiresAt,
      })
      .from(schema.webDocuments)
      .where(inArray(schema.webDocuments.urlHash, hashes));

    const now = Date.now();
    const fresh = new Set<string>();
    for (const row of cached) {
      const expired = row.expiresAt !== null && row.expiresAt.getTime() < now;
      if (expired || !row.extractedText) continue;
      result.set(normalizeUrl(row.url), row.extractedText);
      fresh.add(row.urlHash);
    }

    const missing = urls.filter((url) => !fresh.has(hashByUrl.get(url)!));
    if (missing.length === 0) return result;

    let extracted: Awaited<ReturnType<SearchProvider['extract']>> = [];
    try {
      extracted = await this.search.extract(missing);
    } catch (error) {
      this.logger.warn(`擷取正文失敗，改用既有快取：${describe(error)}`);
      return result;
    }

    const expiresAt = new Date(now + this.env.SEARCH_CACHE_TTL_SECONDS * 1000);
    for (const document of extracted) {
      if (!document.content) continue;
      result.set(normalizeUrl(document.url), document.content);

      await this.database.db
        .insert(schema.webDocuments)
        .values({
          urlHash: computeUrlHash(document.url),
          url: document.url,
          domain: safeHostname(document.url),
          title: document.title,
          extractedText: document.content,
          contentLength: document.content.length,
          httpStatus: 200,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: schema.webDocuments.urlHash,
          set: {
            extractedText: document.content,
            contentLength: document.content.length,
            fetchedAt: new Date(),
            expiresAt,
            updatedAt: new Date(),
          },
        })
        .catch((error: unknown) => {
          this.logger.warn(`寫入 web_documents 失敗：${describe(error)}`);
        });
    }

    return result;
  }

  /**
   * 保存證據來源，並標記哪些真的被 AI 引用。
   *
   * **必須傳入呼叫端的交易物件**：證據集合是在同一個交易裡剛插入的，
   * 用另一條連線寫子表會看不到尚未提交的父列而觸發外鍵錯誤。
   */
  async persistSources(
    tx: Database,
    evidenceSetId: string,
    sources: EvidenceSource[],
    usedSourceIds: ReadonlySet<string>,
  ): Promise<void> {
    if (sources.length === 0) return;

    await tx.insert(schema.questionEvidenceSources).values(
      sources.map((source) => ({
        evidenceSetId,
        sourceId: source.sourceId,
        url: source.url,
        domain: source.domain,
        title: source.title,
        publishedDate: source.publishedDate,
        fetchedAt: new Date(source.fetchedAt),
        contentSnippet: source.content.slice(0, 2000),
        contentLength: source.content.length,
        searchProvider: this.search.name,
        searchQuery: source.searchQuery,
        rank: source.rank,
        score: source.score.toFixed(4),
        trustTier: source.trustTier,
        isUsed: usedSourceIds.has(source.sourceId),
      })),
    );
  }

  /** 讀回某個證據集合的來源，供結果頁顯示。 */
  async loadSources(evidenceSetId: string) {
    return this.database.db
      .select()
      .from(schema.questionEvidenceSources)
      .where(eq(schema.questionEvidenceSources.evidenceSetId, evidenceSetId));
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
