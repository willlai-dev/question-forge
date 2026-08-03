import { Inject, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  normalizeTagName,
  type CreateTagAliasRequest,
  type ListTagAliasesQuery,
  type ResolveTagNameQuery,
  type ResolveTagNameResponse,
  type TagAliasResponse,
  type TagKind,
} from '@repo/contracts';
import { schema, type Database, type DatabaseHandle } from '@repo/db';
import { and, asc, eq, ne } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { DATABASE } from '../../infra/infra.module';

/**
 * 別名與名稱解析（FR-TAG-09）。
 *
 * `resolveTagName` 是**整個系統把「名稱」變成「標籤」的唯一入口**。
 * Phase 4 的 AI 回傳標籤名稱時會走同一支：對得上就用既有標籤，
 * 對不上就只能進 tag_suggestions —— AI 沒有任何路徑可以直接建立標籤（FR-TAG-06）。
 */
@Injectable()
export class TagAliasesService {
  constructor(@Inject(DATABASE) private readonly database: DatabaseHandle) {}

  async list(userId: string, query: ListTagAliasesQuery): Promise<TagAliasResponse[]> {
    const { db } = this.database;
    const conditions = [eq(schema.tagAliases.userId, userId)];
    if (query.tagKind) conditions.push(eq(schema.tagAliases.tagKind, query.tagKind));
    if (query.canonicalTagId)
      conditions.push(eq(schema.tagAliases.canonicalTagId, query.canonicalTagId));

    const rows = await db
      .select()
      .from(schema.tagAliases)
      .where(and(...conditions))
      .orderBy(asc(schema.tagAliases.tagKind), asc(schema.tagAliases.alias));

    const names = await this.loadCanonicalNames(db, rows);

    return rows.map((row) => ({
      id: row.id,
      tagKind: row.tagKind as TagKind,
      alias: row.alias,
      normalizedAlias: row.normalizedAlias,
      canonicalTagId: row.canonicalTagId,
      canonicalTagName: names.get(row.canonicalTagId) ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async create(userId: string, dto: CreateTagAliasRequest): Promise<TagAliasResponse> {
    const canonicalName = await this.assertTagExists(userId, dto.tagKind, dto.canonicalTagId);
    const normalized = normalizeTagName(dto.alias);

    // 別名與標籤本名正規化後相同就沒有意義，而且會讓解析結果變得難以解釋。
    if (normalized === normalizeTagName(canonicalName)) {
      throw new AppException(
        ERROR_CODES.VALIDATION_FAILED,
        '別名與標籤名稱相同，不需要另外建立別名。',
      );
    }

    // 別名不可與「其他」既有標籤的本名衝突，否則同一個名稱會有兩種解讀。
    const conflicting = await this.findTagByNormalizedName(userId, dto.tagKind, normalized);
    if (conflicting && conflicting.id !== dto.canonicalTagId) {
      throw new AppException(
        ERROR_CODES.TAG_NAME_DUPLICATED,
        `「${dto.alias}」已經是標籤「${conflicting.name}」的名稱，不能同時作為別名。`,
      );
    }

    const inserted = await this.database.db
      .insert(schema.tagAliases)
      .values({
        userId,
        tagKind: dto.tagKind,
        alias: dto.alias,
        normalizedAlias: normalized,
        canonicalTagId: dto.canonicalTagId,
      })
      .returning()
      .catch((error: unknown) => {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
          throw new AppException(ERROR_CODES.TAG_NAME_DUPLICATED, '這個別名已經存在。');
        }
        throw error;
      });

    const row = inserted[0]!;
    return {
      id: row.id,
      tagKind: row.tagKind as TagKind,
      alias: row.alias,
      normalizedAlias: row.normalizedAlias,
      canonicalTagId: row.canonicalTagId,
      canonicalTagName: canonicalName,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async remove(userId: string, id: string): Promise<void> {
    const deleted = await this.database.db
      .delete(schema.tagAliases)
      .where(and(eq(schema.tagAliases.id, id), eq(schema.tagAliases.userId, userId)))
      .returning({ id: schema.tagAliases.id });

    if (deleted.length === 0) {
      throw new AppException(ERROR_CODES.NOT_FOUND, '找不到指定的別名。');
    }
  }

  /**
   * 把一個名稱解析成既有標籤。
   *
   * 先比本名，再比別名。回傳 null 代表「這個系統裡沒有這個標籤」，
   * 呼叫端唯一的合法後續動作是建立 tag_suggestion，不是自行建立標籤。
   */
  async resolve(userId: string, query: ResolveTagNameQuery): Promise<ResolveTagNameResponse> {
    const normalized = normalizeTagName(query.name);

    const byName = await this.findTagByNormalizedName(userId, query.tagKind, normalized);
    if (byName) {
      return {
        input: query.name,
        normalized,
        matchedTagId: byName.id,
        matchedTagName: byName.name,
        matchedVia: 'name',
      };
    }

    const aliasRows = await this.database.db
      .select({ canonicalTagId: schema.tagAliases.canonicalTagId })
      .from(schema.tagAliases)
      .where(
        and(
          eq(schema.tagAliases.userId, userId),
          eq(schema.tagAliases.tagKind, query.tagKind),
          eq(schema.tagAliases.normalizedAlias, normalized),
        ),
      )
      .limit(1);

    const canonicalId = aliasRows[0]?.canonicalTagId;
    if (!canonicalId) {
      return {
        input: query.name,
        normalized,
        matchedTagId: null,
        matchedTagName: null,
        matchedVia: null,
      };
    }

    const name = await this.loadTagName(userId, query.tagKind, canonicalId);
    return {
      input: query.name,
      normalized,
      matchedTagId: name === null ? null : canonicalId,
      matchedTagName: name,
      matchedVia: name === null ? null : 'alias',
    };
  }

  // ------------------------------------------------------------- helpers

  /** 依 tag_kind 查對應的表。三類標籤各自有表，因此無法用單一外鍵表達。 */
  private async findTagByNormalizedName(
    userId: string,
    tagKind: TagKind,
    normalized: string,
  ): Promise<{ id: string; name: string } | null> {
    const { db } = this.database;

    // 解析結果的唯一用途是「拿去掛到題目上」，因此判準必須與手動掛標籤一致：
    // merged 與 deprecated 都不可用（見 QuestionTagsService.assertKnowledgeTagsUsable）。
    // 之前只擋 merged，於是 AI 可以掛上一個已停用的知識點——那正是停用要防止的事。
    // 解析不到會回 null，呼叫端唯一的後續動作是建立 tag_suggestion 交由人工審核。
    if (tagKind === 'knowledge') {
      const rows = await db
        .select({ id: schema.knowledgeTags.id, name: schema.knowledgeTags.name })
        .from(schema.knowledgeTags)
        .where(
          and(
            eq(schema.knowledgeTags.userId, userId),
            eq(schema.knowledgeTags.slug, normalized),
            ne(schema.knowledgeTags.status, 'merged'),
            ne(schema.knowledgeTags.status, 'deprecated'),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    }

    if (tagKind === 'skill') {
      const rows = await db
        .select({ id: schema.skillTags.id, name: schema.skillTags.name })
        .from(schema.skillTags)
        .where(
          and(
            eq(schema.skillTags.slug, normalized),
            ne(schema.skillTags.status, 'deprecated'),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    }

    // 錯誤類型可用 code 或名稱比對：AI prompt 給的是 code，使用者輸入的是名稱。
    const rows = await db.select().from(schema.errorTypes);
    const matched = rows.find(
      (row) => normalizeTagName(row.name) === normalized || row.code === normalized,
    );
    return matched ? { id: matched.id, name: matched.name } : null;
  }

  private async loadTagName(
    userId: string,
    tagKind: TagKind,
    tagId: string,
  ): Promise<string | null> {
    const { db } = this.database;

    if (tagKind === 'knowledge') {
      const rows = await db
        .select({ name: schema.knowledgeTags.name })
        .from(schema.knowledgeTags)
        .where(and(eq(schema.knowledgeTags.id, tagId), eq(schema.knowledgeTags.userId, userId)))
        .limit(1);
      return rows[0]?.name ?? null;
    }
    if (tagKind === 'skill') {
      const rows = await db
        .select({ name: schema.skillTags.name })
        .from(schema.skillTags)
        .where(eq(schema.skillTags.id, tagId))
        .limit(1);
      return rows[0]?.name ?? null;
    }
    const rows = await db
      .select({ name: schema.errorTypes.name })
      .from(schema.errorTypes)
      .where(eq(schema.errorTypes.id, tagId))
      .limit(1);
    return rows[0]?.name ?? null;
  }

  /** 確認標籤存在並回傳名稱。公開給 tag-suggestions 驗證併入目標使用。 */
  async assertTagExists(
    userId: string,
    tagKind: TagKind,
    tagId: string,
    message = '找不到別名要指向的標籤。',
  ): Promise<string> {
    const name = await this.loadTagName(userId, tagKind, tagId);
    if (name === null) throw new AppException(ERROR_CODES.TAG_NOT_FOUND, message);
    return name;
  }

  private async loadCanonicalNames(
    db: Database,
    rows: (typeof schema.tagAliases.$inferSelect)[],
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (rows.length === 0) return names;

    const [knowledge, skills, errors] = await Promise.all([
      db.select({ id: schema.knowledgeTags.id, name: schema.knowledgeTags.name }).from(schema.knowledgeTags),
      db.select({ id: schema.skillTags.id, name: schema.skillTags.name }).from(schema.skillTags),
      db.select({ id: schema.errorTypes.id, name: schema.errorTypes.name }).from(schema.errorTypes),
    ]);

    for (const row of [...knowledge, ...skills, ...errors]) names.set(row.id, row.name);
    return names;
  }
}
