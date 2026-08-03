import { Inject, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  toTagSlug,
  type CreateKnowledgeTagRequest,
  type KnowledgeTagResponse,
  type ListKnowledgeTagsQuery,
  type PaginationMeta,
  type UpdateKnowledgeTagRequest,
} from '@repo/contracts';
import { schema, type Database, type DatabaseHandle } from '@repo/db';
import { and, asc, eq, ilike, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { DATABASE } from '../../infra/infra.module';

type TagRow = typeof schema.knowledgeTags.$inferSelect;

@Injectable()
export class KnowledgeTagsService {
  constructor(@Inject(DATABASE) private readonly database: DatabaseHandle) {}

  async list(
    userId: string,
    query: ListKnowledgeTagsQuery,
  ): Promise<{ items: KnowledgeTagResponse[]; pagination: PaginationMeta }> {
    const { db } = this.database;
    const conditions: SQL[] = [eq(schema.knowledgeTags.userId, userId)];

    if (query.q) conditions.push(ilike(schema.knowledgeTags.name, `%${query.q}%`));
    if (query.subjectId === 'none') conditions.push(isNull(schema.knowledgeTags.subjectId));
    else if (query.subjectId) conditions.push(eq(schema.knowledgeTags.subjectId, query.subjectId));
    if (query.status) conditions.push(eq(schema.knowledgeTags.status, query.status));
    // 預設不列出已合併的標籤：它們只是歷史指標，對日常操作是雜訊。
    else conditions.push(ne(schema.knowledgeTags.status, 'merged'));

    const where = and(...conditions);

    const totalRows = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.knowledgeTags)
      .where(where);
    const total = totalRows[0]?.total ?? 0;

    const rows = await db
      .select()
      .from(schema.knowledgeTags)
      .where(where)
      .orderBy(asc(schema.knowledgeTags.name), asc(schema.knowledgeTags.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      items: await this.hydrate(rows),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  }

  async getOrThrow(userId: string, id: string): Promise<KnowledgeTagResponse> {
    const row = await this.loadRow(userId, id);
    const [hydrated] = await this.hydrate([row]);
    return hydrated!;
  }

  async create(userId: string, dto: CreateKnowledgeTagRequest): Promise<KnowledgeTagResponse> {
    await this.assertSubjectExists(userId, dto.subjectId);
    if (dto.parentId) await this.loadRow(userId, dto.parentId);

    const inserted = await this.database.db
      .insert(schema.knowledgeTags)
      .values({
        userId,
        subjectId: dto.subjectId ?? null,
        name: dto.name,
        slug: toTagSlug(dto.name),
        description: dto.description ?? null,
        parentId: dto.parentId ?? null,
      })
      .returning({ id: schema.knowledgeTags.id })
      .catch((error: unknown) => {
        throw this.translateDuplicate(error);
      });

    return this.getOrThrow(userId, inserted[0]!.id);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateKnowledgeTagRequest,
  ): Promise<KnowledgeTagResponse> {
    const existing = await this.loadRow(userId, id);
    if (existing.status === 'merged') {
      throw new AppException(ERROR_CODES.CONFLICT, '已合併的標籤不可再修改。');
    }

    if (dto.parentId) {
      if (dto.parentId === id) {
        throw new AppException(ERROR_CODES.VALIDATION_FAILED, '標籤不可以自己為上層。');
      }
      await this.loadRow(userId, dto.parentId);
      await this.assertNoCycle(id, dto.parentId);
    }
    if (dto.subjectId !== undefined) await this.assertSubjectExists(userId, dto.subjectId);

    await this.database.db
      .update(schema.knowledgeTags)
      .set({
        ...(dto.name !== undefined ? { name: dto.name, slug: toTagSlug(dto.name) } : {}),
        ...(dto.subjectId !== undefined ? { subjectId: dto.subjectId ?? null } : {}),
        ...(dto.description !== undefined ? { description: dto.description ?? null } : {}),
        ...(dto.parentId !== undefined ? { parentId: dto.parentId ?? null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.knowledgeTags.id, id))
      .catch((error: unknown) => {
        throw this.translateDuplicate(error);
      });

    return this.getOrThrow(userId, id);
  }

  async deprecate(userId: string, id: string): Promise<KnowledgeTagResponse> {
    const existing = await this.loadRow(userId, id);
    if (existing.status === 'merged') {
      throw new AppException(ERROR_CODES.CONFLICT, '已合併的標籤不可再停用。');
    }

    // 停用不解除既有關聯：歷史上這些題目確實掛過這個知識點，抹掉會讓統計對不起來。
    await this.database.db
      .update(schema.knowledgeTags)
      .set({ status: 'deprecated', updatedAt: new Date() })
      .where(eq(schema.knowledgeTags.id, id));

    return this.getOrThrow(userId, id);
  }

  async activate(userId: string, id: string): Promise<KnowledgeTagResponse> {
    const existing = await this.loadRow(userId, id);
    if (existing.status === 'merged') {
      throw new AppException(ERROR_CODES.CONFLICT, '已合併的標籤不可重新啟用。');
    }

    await this.database.db
      .update(schema.knowledgeTags)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(schema.knowledgeTags.id, id))
      .catch((error: unknown) => {
        throw this.translateDuplicate(error);
      });

    return this.getOrThrow(userId, id);
  }

  /**
   * 刪除標籤。
   *
   * 只允許刪除完全沒被使用的標籤。已經掛在題目上的標籤要退場請用停用或合併 ——
   * 直接刪除會讓既有題目的標註無聲消失（§20.19 不得刪除既有資料）。
   */
  async remove(userId: string, id: string): Promise<void> {
    await this.loadRow(userId, id);
    const usage = await this.countUsage([id]);
    const count = usage.get(id) ?? 0;

    if (count > 0) {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        `這個知識點已掛在 ${count} 題上，不能直接刪除。請改用停用，或合併到其他知識點。`,
      );
    }

    const children = await this.database.db
      .select({ id: schema.knowledgeTags.id })
      .from(schema.knowledgeTags)
      .where(eq(schema.knowledgeTags.parentId, id))
      .limit(1);
    if (children.length > 0) {
      throw new AppException(ERROR_CODES.CONFLICT, '這個知識點底下還有子項目，請先處理。');
    }

    await this.database.db.transaction(async (tx) => {
      await tx.delete(schema.tagAliases).where(eq(schema.tagAliases.canonicalTagId, id));
      await tx.delete(schema.knowledgeTags).where(eq(schema.knowledgeTags.id, id));
    });
  }

  /**
   * 合併標籤（FR-TAG-10）。
   *
   * 來源標籤的所有關聯必須完整轉移到目標，一筆都不能掉。
   * 難點在於部分唯一索引「每題最多一個 primary」：
   * 若某題同時掛了來源與目標，單純把 tag_id 改掉會撞主鍵，
   * 因此要合併兩列的角色 —— 任一方是 primary，合併後就是 primary。
   */
  async merge(userId: string, sourceId: string, targetId: string): Promise<KnowledgeTagResponse> {
    if (sourceId === targetId) {
      throw new AppException(ERROR_CODES.TAG_MERGE_INVALID_TARGET, '不能把標籤合併到自己。');
    }

    const source = await this.loadRow(userId, sourceId);
    const target = await this.loadRow(userId, targetId);

    if (source.status === 'merged') {
      throw new AppException(ERROR_CODES.CONFLICT, '這個標籤已經被合併過了。');
    }
    if (target.status === 'merged') {
      throw new AppException(
        ERROR_CODES.TAG_MERGE_INVALID_TARGET,
        '不能合併到一個已被合併的標籤，請選擇它的合併目標。',
      );
    }

    await this.database.db.transaction(async (tx) => {
      await this.transferQuestionLinks(tx, sourceId, targetId);

      // 子標籤改掛到合併目標下，否則會指向一個已退場的節點。
      await tx
        .update(schema.knowledgeTags)
        .set({ parentId: targetId, updatedAt: new Date() })
        .where(eq(schema.knowledgeTags.parentId, sourceId));

      // 指向來源的別名改指目標，並把來源名稱本身登錄成別名 ——
      // 下次再出現這個名稱就會直接對應到目標，不會又變成一筆新建議。
      await tx
        .update(schema.tagAliases)
        .set({ canonicalTagId: targetId })
        .where(eq(schema.tagAliases.canonicalTagId, sourceId));

      await tx
        .insert(schema.tagAliases)
        .values({
          userId,
          tagKind: 'knowledge',
          alias: source.name,
          normalizedAlias: toTagSlug(source.name),
          canonicalTagId: targetId,
        })
        .onConflictDoNothing();

      await tx
        .update(schema.tagSuggestions)
        .set({ resolvedTagId: targetId })
        .where(eq(schema.tagSuggestions.resolvedTagId, sourceId));

      await tx
        .update(schema.knowledgeTags)
        .set({ status: 'merged', mergedIntoId: targetId, updatedAt: new Date() })
        .where(eq(schema.knowledgeTags.id, sourceId));
    });

    return this.getOrThrow(userId, targetId);
  }

  /** 把題目關聯從來源標籤搬到目標標籤，處理兩者都存在時的角色合併。 */
  private async transferQuestionLinks(
    tx: Database,
    sourceId: string,
    targetId: string,
  ): Promise<void> {
    const sourceLinks = await tx
      .select()
      .from(schema.questionKnowledgeTags)
      .where(eq(schema.questionKnowledgeTags.knowledgeTagId, sourceId));

    if (sourceLinks.length === 0) return;

    const questionIds = sourceLinks.map((link) => link.questionId);
    const targetLinks = await tx
      .select()
      .from(schema.questionKnowledgeTags)
      .where(
        and(
          eq(schema.questionKnowledgeTags.knowledgeTagId, targetId),
          inArray(schema.questionKnowledgeTags.questionId, questionIds),
        ),
      );
    const targetByQuestion = new Map(targetLinks.map((link) => [link.questionId, link]));

    for (const link of sourceLinks) {
      const existing = targetByQuestion.get(link.questionId);

      if (!existing) {
        await tx
          .update(schema.questionKnowledgeTags)
          .set({ knowledgeTagId: targetId })
          .where(
            and(
              eq(schema.questionKnowledgeTags.questionId, link.questionId),
              eq(schema.questionKnowledgeTags.knowledgeTagId, sourceId),
            ),
          );
        continue;
      }

      // 兩邊都掛了：主要角色優先保留。
      const mergedRole = link.role === 'primary' || existing.role === 'primary' ? 'primary' : 'secondary';

      // **必須先刪來源、再升級目標。** 反過來的話，在「來源是 primary、目標是 secondary」
      // 的情況下會有一瞬間同一題出現兩列 role='primary'，
      // 而 question_knowledge_tags_primary_unique 是部分唯一索引（WHERE role = 'primary'），
      // 會直接擋下並讓整個合併以 500 收場。
      await tx
        .delete(schema.questionKnowledgeTags)
        .where(
          and(
            eq(schema.questionKnowledgeTags.questionId, link.questionId),
            eq(schema.questionKnowledgeTags.knowledgeTagId, sourceId),
          ),
        );

      if (mergedRole !== existing.role) {
        await tx
          .update(schema.questionKnowledgeTags)
          .set({ role: mergedRole })
          .where(
            and(
              eq(schema.questionKnowledgeTags.questionId, link.questionId),
              eq(schema.questionKnowledgeTags.knowledgeTagId, targetId),
            ),
          );
      }
    }
  }

  // ------------------------------------------------------------- helpers

  private async loadRow(userId: string, id: string): Promise<TagRow> {
    const rows = await this.database.db
      .select()
      .from(schema.knowledgeTags)
      .where(and(eq(schema.knowledgeTags.id, id), eq(schema.knowledgeTags.userId, userId)))
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppException(ERROR_CODES.TAG_NOT_FOUND, '找不到指定的知識點。');
    return row;
  }

  /**
   * 使用次數採即時計算，不存 `usage_count` 欄位。
   *
   * 這與錯題紀錄的處理原則一致：可被推導的數字就不要另存一份 ——
   * 合併、刪除、改標籤都會影響它，任何一條路徑忘了維護就會靜默失準。
   */
  private async countUsage(tagIds: string[]): Promise<Map<string, number>> {
    if (tagIds.length === 0) return new Map();

    const rows = await this.database.db
      .select({
        tagId: schema.questionKnowledgeTags.knowledgeTagId,
        total: sql<number>`count(*)::int`,
      })
      .from(schema.questionKnowledgeTags)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.questionKnowledgeTags.questionId))
      .where(
        and(
          inArray(schema.questionKnowledgeTags.knowledgeTagId, tagIds),
          isNull(schema.questions.deletedAt),
        ),
      )
      .groupBy(schema.questionKnowledgeTags.knowledgeTagId);

    return new Map(rows.map((row) => [row.tagId, row.total]));
  }

  private async hydrate(rows: TagRow[]): Promise<KnowledgeTagResponse[]> {
    if (rows.length === 0) return [];
    const { db } = this.database;

    const ids = rows.map((row) => row.id);
    const usage = await this.countUsage(ids);

    const aliasRows = await db
      .select({ canonicalTagId: schema.tagAliases.canonicalTagId, alias: schema.tagAliases.alias })
      .from(schema.tagAliases)
      .where(
        and(
          eq(schema.tagAliases.tagKind, 'knowledge'),
          inArray(schema.tagAliases.canonicalTagId, ids),
        ),
      );
    const aliasMap = new Map<string, string[]>();
    for (const row of aliasRows) {
      const list = aliasMap.get(row.canonicalTagId) ?? [];
      list.push(row.alias);
      aliasMap.set(row.canonicalTagId, list);
    }

    const relatedIds = [
      ...new Set(
        rows.flatMap((row) => [row.parentId, row.mergedIntoId].filter((v): v is string => !!v)),
      ),
    ];
    const relatedNames = new Map<string, string>();
    if (relatedIds.length > 0) {
      const related = await db
        .select({ id: schema.knowledgeTags.id, name: schema.knowledgeTags.name })
        .from(schema.knowledgeTags)
        .where(inArray(schema.knowledgeTags.id, relatedIds));
      for (const row of related) relatedNames.set(row.id, row.name);
    }

    const subjectIds = [...new Set(rows.map((row) => row.subjectId).filter((v): v is string => !!v))];
    const subjectNames = new Map<string, string>();
    if (subjectIds.length > 0) {
      const subjects = await db
        .select({ id: schema.subjects.id, name: schema.subjects.name })
        .from(schema.subjects)
        .where(inArray(schema.subjects.id, subjectIds));
      for (const row of subjects) subjectNames.set(row.id, row.name);
    }

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      subjectId: row.subjectId,
      subjectName: row.subjectId ? (subjectNames.get(row.subjectId) ?? null) : null,
      description: row.description,
      parentId: row.parentId,
      parentName: row.parentId ? (relatedNames.get(row.parentId) ?? null) : null,
      status: row.status as KnowledgeTagResponse['status'],
      mergedIntoId: row.mergedIntoId,
      mergedIntoName: row.mergedIntoId ? (relatedNames.get(row.mergedIntoId) ?? null) : null,
      usageCount: usage.get(row.id) ?? 0,
      aliases: aliasMap.get(row.id) ?? [],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  private async assertSubjectExists(userId: string, subjectId: string | null | undefined): Promise<void> {
    if (!subjectId) return;
    const rows = await this.database.db
      .select({ id: schema.subjects.id })
      .from(schema.subjects)
      .where(
        and(
          eq(schema.subjects.id, subjectId),
          eq(schema.subjects.userId, userId),
          isNull(schema.subjects.deletedAt),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new AppException(ERROR_CODES.SUBJECT_NOT_FOUND, '找不到指定的科目。');
    }
  }

  /**
   * 沿著 parent 往上走，確認不會形成環。
   * 深度設上限，避免既有壞資料（若曾繞過本檢查）造成無限迴圈。
   */
  private async assertNoCycle(id: string, parentId: string): Promise<void> {
    let current: string | null = parentId;
    for (let depth = 0; depth < 100 && current; depth += 1) {
      if (current === id) {
        throw new AppException(ERROR_CODES.VALIDATION_FAILED, '不能把標籤掛到自己的子項目底下。');
      }
      const rows: { parentId: string | null }[] = await this.database.db
        .select({ parentId: schema.knowledgeTags.parentId })
        .from(schema.knowledgeTags)
        .where(eq(schema.knowledgeTags.id, current))
        .limit(1);
      current = rows[0]?.parentId ?? null;
    }
  }

  private translateDuplicate(error: unknown): unknown {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      return new AppException(ERROR_CODES.TAG_NAME_DUPLICATED, '同一範圍內已有同名的知識點。');
    }
    return error;
  }
}
