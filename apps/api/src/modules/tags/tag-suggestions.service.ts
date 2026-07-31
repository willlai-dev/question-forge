import { Inject, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  normalizeTagName,
  toTagSlug,
  type ApproveTagSuggestionRequest,
  type CreateTagSuggestionRequest,
  type ListTagSuggestionsQuery,
  type MergeTagSuggestionRequest,
  type PaginationMeta,
  type RejectTagSuggestionRequest,
  type TagKind,
  type TagSuggestionResponse,
} from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { DATABASE } from '../../infra/infra.module';
import { TagAliasesService } from './tag-aliases.service';

type SuggestionRow = typeof schema.tagSuggestions.$inferSelect;

/**
 * 標籤建議的審核流程（FR-TAG-07）。
 *
 * **這是「新標籤」進入系統的唯一通道**。規格 §8 要求 AI 不得自行建立正式標籤，
 * 因此 Phase 4 的分析結果若提到未知標籤，只能寫進這裡等人裁決：
 *   - approve：建立正式標籤
 *   - merge：併入既有標籤，並自動登錄別名，下次同名就不會再變成建議
 *   - reject：留下紀錄與理由，不建立任何東西
 */
@Injectable()
export class TagSuggestionsService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    private readonly aliases: TagAliasesService,
  ) {}

  async list(
    userId: string,
    query: ListTagSuggestionsQuery,
  ): Promise<{ items: TagSuggestionResponse[]; pagination: PaginationMeta }> {
    const { db } = this.database;
    const conditions: SQL[] = [eq(schema.tagSuggestions.userId, userId)];
    if (query.status) conditions.push(eq(schema.tagSuggestions.status, query.status));
    if (query.tagKind) conditions.push(eq(schema.tagSuggestions.tagKind, query.tagKind));
    const where = and(...conditions);

    const totalRows = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.tagSuggestions)
      .where(where);
    const total = totalRows[0]?.total ?? 0;

    const rows = await db
      .select()
      .from(schema.tagSuggestions)
      .where(where)
      // 重複被建議越多次的越優先審核。
      .orderBy(desc(schema.tagSuggestions.occurrenceCount), desc(schema.tagSuggestions.createdAt))
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

  /**
   * 提交建議。
   *
   * 若該名稱其實已經對得上既有標籤（含別名），直接回 409 並指出對應的標籤 ——
   * 讓已經有答案的東西進入待審佇列，只會製造無意義的審核工作。
   * 同一個待審名稱重複提交則累加 occurrence_count，不會產生一堆重複列。
   */
  async create(
    userId: string,
    dto: CreateTagSuggestionRequest,
    source: 'ai' | 'user' = 'user',
  ): Promise<TagSuggestionResponse> {
    const resolved = await this.aliases.resolve(userId, {
      tagKind: dto.tagKind,
      name: dto.suggestedName,
    });

    if (resolved.matchedTagId) {
      throw new AppException(
        ERROR_CODES.TAG_NAME_DUPLICATED,
        `「${dto.suggestedName}」已經對應到既有標籤「${resolved.matchedTagName}」，不需要建議。`,
      );
    }

    if (dto.contextQuestionId) await this.assertQuestionExists(userId, dto.contextQuestionId);

    const normalized = normalizeTagName(dto.suggestedName);
    const inserted = await this.database.db
      .insert(schema.tagSuggestions)
      .values({
        userId,
        tagKind: dto.tagKind,
        suggestedName: dto.suggestedName,
        normalizedName: normalized,
        contextQuestionId: dto.contextQuestionId ?? null,
        source,
        rationale: dto.rationale ?? null,
      })
      .onConflictDoUpdate({
        target: [
          schema.tagSuggestions.userId,
          schema.tagSuggestions.tagKind,
          schema.tagSuggestions.normalizedName,
        ],
        targetWhere: sql`status = 'pending'`,
        set: {
          occurrenceCount: sql`${schema.tagSuggestions.occurrenceCount} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning({ id: schema.tagSuggestions.id });

    return this.getOrThrow(userId, inserted[0]!.id);
  }

  async approve(
    userId: string,
    id: string,
    dto: ApproveTagSuggestionRequest,
  ): Promise<TagSuggestionResponse> {
    const suggestion = await this.loadPending(userId, id);
    const name = dto.name ?? suggestion.suggestedName;

    if (suggestion.tagKind === 'error_type') {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        '錯誤類型是固定的診斷詞彙，不接受新增。請改為併入既有的錯誤類型，或直接退回。',
      );
    }

    const tagId = await this.database.db.transaction(async (tx) => {
      let createdId: string;

      if (suggestion.tagKind === 'knowledge') {
        const inserted = await tx
          .insert(schema.knowledgeTags)
          .values({
            userId,
            subjectId: dto.subjectId ?? null,
            name,
            slug: toTagSlug(name),
            description: dto.description ?? null,
          })
          .returning({ id: schema.knowledgeTags.id })
          .catch((error: unknown) => {
            throw this.translateDuplicate(error);
          });
        createdId = inserted[0]!.id;
      } else {
        const [maxOrder] = await tx
          .select({ value: sql<number>`coalesce(max(${schema.skillTags.sortOrder}), -1)::int` })
          .from(schema.skillTags);
        const inserted = await tx
          .insert(schema.skillTags)
          .values({
            name,
            slug: toTagSlug(name),
            description: dto.description ?? null,
            sortOrder: (maxOrder?.value ?? -1) + 1,
          })
          .returning({ id: schema.skillTags.id })
          .catch((error: unknown) => {
            throw this.translateDuplicate(error);
          });
        createdId = inserted[0]!.id;
      }

      // 審核時改了名字的話，把原本建議的名稱登錄成別名，
      // 否則同一個來源下次還是會提出同樣的建議。
      if (normalizeTagName(name) !== suggestion.normalizedName) {
        await tx
          .insert(schema.tagAliases)
          .values({
            userId,
            tagKind: suggestion.tagKind,
            alias: suggestion.suggestedName,
            normalizedAlias: suggestion.normalizedName,
            canonicalTagId: createdId,
          })
          .onConflictDoNothing();
      }

      await tx
        .update(schema.tagSuggestions)
        .set({
          status: 'approved',
          resolvedTagId: createdId,
          reviewedAt: new Date(),
          reviewNote: dto.reviewNote ?? null,
          updatedAt: new Date(),
        })
        .where(eq(schema.tagSuggestions.id, id));

      return createdId;
    });

    void tagId; // 建立結果透過建議紀錄的 resolvedTagId 回傳
    return this.getOrThrow(userId, id);
  }

  async merge(
    userId: string,
    id: string,
    dto: MergeTagSuggestionRequest,
  ): Promise<TagSuggestionResponse> {
    const suggestion = await this.loadPending(userId, id);

    // 併入目標必須真的存在，且必須與建議是同一類標籤 ——
    // 否則會產生一個指向不存在（或錯類）標籤的別名，之後解析就會靜默失敗。
    await this.aliases.assertTagExists(
      userId,
      suggestion.tagKind as TagKind,
      dto.targetTagId,
      '找不到要併入的標籤，或它不屬於同一類標籤。',
    );

    await this.database.db.transaction(async (tx) => {
      await tx
        .insert(schema.tagAliases)
        .values({
          userId,
          tagKind: suggestion.tagKind,
          alias: suggestion.suggestedName,
          normalizedAlias: suggestion.normalizedName,
          canonicalTagId: dto.targetTagId,
        })
        .onConflictDoNothing();

      await tx
        .update(schema.tagSuggestions)
        .set({
          status: 'merged',
          resolvedTagId: dto.targetTagId,
          reviewedAt: new Date(),
          reviewNote: dto.reviewNote ?? null,
          updatedAt: new Date(),
        })
        .where(eq(schema.tagSuggestions.id, id));
    });

    return this.getOrThrow(userId, id);
  }

  async reject(
    userId: string,
    id: string,
    dto: RejectTagSuggestionRequest,
  ): Promise<TagSuggestionResponse> {
    await this.loadPending(userId, id);

    await this.database.db
      .update(schema.tagSuggestions)
      .set({
        status: 'rejected',
        reviewedAt: new Date(),
        reviewNote: dto.reviewNote ?? null,
        updatedAt: new Date(),
      })
      .where(eq(schema.tagSuggestions.id, id));

    return this.getOrThrow(userId, id);
  }

  async getOrThrow(userId: string, id: string): Promise<TagSuggestionResponse> {
    const rows = await this.database.db
      .select()
      .from(schema.tagSuggestions)
      .where(and(eq(schema.tagSuggestions.id, id), eq(schema.tagSuggestions.userId, userId)))
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppException(ERROR_CODES.NOT_FOUND, '找不到指定的標籤建議。');

    const [hydrated] = await this.hydrate([row]);
    return hydrated!;
  }

  // ------------------------------------------------------------- helpers

  private async loadPending(userId: string, id: string): Promise<SuggestionRow> {
    const rows = await this.database.db
      .select()
      .from(schema.tagSuggestions)
      .where(and(eq(schema.tagSuggestions.id, id), eq(schema.tagSuggestions.userId, userId)))
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppException(ERROR_CODES.NOT_FOUND, '找不到指定的標籤建議。');
    if (row.status !== 'pending') {
      throw new AppException(ERROR_CODES.CONFLICT, `這筆建議已經處理過了（${row.status}）。`);
    }
    return row;
  }

  private async assertQuestionExists(userId: string, questionId: string): Promise<void> {
    const rows = await this.database.db
      .select({ id: schema.questions.id })
      .from(schema.questions)
      .where(and(eq(schema.questions.id, questionId), eq(schema.questions.userId, userId)))
      .limit(1);
    if (rows.length === 0) {
      throw new AppException(ERROR_CODES.QUESTION_NOT_FOUND, '找不到指定的題目。');
    }
  }

  private async hydrate(rows: SuggestionRow[]): Promise<TagSuggestionResponse[]> {
    if (rows.length === 0) return [];
    const { db } = this.database;

    const questionIds = [
      ...new Set(rows.map((row) => row.contextQuestionId).filter((v): v is string => !!v)),
    ];
    const stems = new Map<string, string>();
    if (questionIds.length > 0) {
      const questions = await db
        .select({ id: schema.questions.id, stem: schema.questions.stem })
        .from(schema.questions)
        .where(inArray(schema.questions.id, questionIds));
      for (const row of questions) stems.set(row.id, row.stem);
    }

    const resolvedIds = [
      ...new Set(rows.map((row) => row.resolvedTagId).filter((v): v is string => !!v)),
    ];
    const resolvedNames = new Map<string, string>();
    if (resolvedIds.length > 0) {
      const [knowledge, skills, errors] = await Promise.all([
        db
          .select({ id: schema.knowledgeTags.id, name: schema.knowledgeTags.name })
          .from(schema.knowledgeTags)
          .where(inArray(schema.knowledgeTags.id, resolvedIds)),
        db
          .select({ id: schema.skillTags.id, name: schema.skillTags.name })
          .from(schema.skillTags)
          .where(inArray(schema.skillTags.id, resolvedIds)),
        db
          .select({ id: schema.errorTypes.id, name: schema.errorTypes.name })
          .from(schema.errorTypes)
          .where(inArray(schema.errorTypes.id, resolvedIds)),
      ]);
      for (const row of [...knowledge, ...skills, ...errors]) resolvedNames.set(row.id, row.name);
    }

    return rows.map((row) => ({
      id: row.id,
      tagKind: row.tagKind as TagKind,
      suggestedName: row.suggestedName,
      normalizedName: row.normalizedName,
      contextQuestionId: row.contextQuestionId,
      contextQuestionStem: row.contextQuestionId ? (stems.get(row.contextQuestionId) ?? null) : null,
      source: row.source as 'ai' | 'user',
      rationale: row.rationale,
      occurrenceCount: row.occurrenceCount,
      status: row.status as TagSuggestionResponse['status'],
      resolvedTagId: row.resolvedTagId,
      resolvedTagName: row.resolvedTagId ? (resolvedNames.get(row.resolvedTagId) ?? null) : null,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviewNote: row.reviewNote,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private translateDuplicate(error: unknown): unknown {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      return new AppException(
        ERROR_CODES.TAG_NAME_DUPLICATED,
        '已有同名的標籤，請改用「併入既有標籤」。',
      );
    }
    return error;
  }
}
