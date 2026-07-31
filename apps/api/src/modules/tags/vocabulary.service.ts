import { Inject, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  toTagSlug,
  type CreateSkillTagRequest,
  type ErrorTypeResponse,
  type SkillTagResponse,
  type UpdateErrorTypeRequest,
  type UpdateSkillTagRequest,
} from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { DATABASE } from '../../infra/infra.module';

/**
 * 能力類型與錯誤類型。
 *
 * 兩者都是系統預設的診斷詞彙（由 TagSeedService 建立），因此：
 *   - 錯誤類型**不提供新增與刪除** —— 自由新增會讓錯因統計失去可比較性。
 *   - 能力類型允許新增（不同科目可能有特殊的能力面向），但同樣不提供刪除。
 * 要讓某一項退場一律用停用，既有題目的標註因此不會消失。
 */
@Injectable()
export class VocabularyService {
  constructor(@Inject(DATABASE) private readonly database: DatabaseHandle) {}

  // ------------------------------------------------------------ 能力類型

  async listSkillTags(includeDeprecated: boolean): Promise<SkillTagResponse[]> {
    const { db } = this.database;
    const rows = await db
      .select()
      .from(schema.skillTags)
      .where(includeDeprecated ? undefined : eq(schema.skillTags.status, 'active'))
      .orderBy(asc(schema.skillTags.sortOrder), asc(schema.skillTags.name));

    const usage = await this.countSkillUsage(rows.map((row) => row.id));
    const aliases = await this.loadAliases('skill', rows.map((row) => row.id));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      sortOrder: row.sortOrder,
      status: row.status as SkillTagResponse['status'],
      usageCount: usage.get(row.id) ?? 0,
      aliases: aliases.get(row.id) ?? [],
    }));
  }

  async createSkillTag(dto: CreateSkillTagRequest): Promise<SkillTagResponse> {
    const { db } = this.database;
    const [maxOrder] = await db
      .select({ value: sql<number>`coalesce(max(${schema.skillTags.sortOrder}), -1)::int` })
      .from(schema.skillTags);

    const inserted = await db
      .insert(schema.skillTags)
      .values({
        name: dto.name,
        slug: toTagSlug(dto.name),
        description: dto.description ?? null,
        sortOrder: (maxOrder?.value ?? -1) + 1,
      })
      .returning({ id: schema.skillTags.id })
      .catch((error: unknown) => {
        throw this.translateDuplicate(error, '已有同名的能力類型。');
      });

    const all = await this.listSkillTags(true);
    return all.find((tag) => tag.id === inserted[0]!.id)!;
  }

  async updateSkillTag(id: string, dto: UpdateSkillTagRequest): Promise<SkillTagResponse> {
    const rows = await this.database.db
      .select({ id: schema.skillTags.id })
      .from(schema.skillTags)
      .where(eq(schema.skillTags.id, id))
      .limit(1);
    if (rows.length === 0) throw new AppException(ERROR_CODES.TAG_NOT_FOUND, '找不到指定的能力類型。');

    await this.database.db
      .update(schema.skillTags)
      .set({
        ...(dto.name !== undefined ? { name: dto.name, slug: toTagSlug(dto.name) } : {}),
        ...(dto.description !== undefined ? { description: dto.description ?? null } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.skillTags.id, id))
      .catch((error: unknown) => {
        throw this.translateDuplicate(error, '已有同名的能力類型。');
      });

    const all = await this.listSkillTags(true);
    return all.find((tag) => tag.id === id)!;
  }

  // ------------------------------------------------------------ 錯誤類型

  async listErrorTypes(includeDeprecated: boolean): Promise<ErrorTypeResponse[]> {
    const { db } = this.database;
    const rows = await db
      .select()
      .from(schema.errorTypes)
      .where(includeDeprecated ? undefined : eq(schema.errorTypes.status, 'active'))
      .orderBy(asc(schema.errorTypes.sortOrder), asc(schema.errorTypes.name));

    const usage = await this.countErrorTypeUsage(rows.map((row) => row.id));

    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      sortOrder: row.sortOrder,
      status: row.status as ErrorTypeResponse['status'],
      isFallback: row.isFallback,
      usageCount: usage.get(row.id) ?? 0,
    }));
  }

  async updateErrorType(id: string, dto: UpdateErrorTypeRequest): Promise<ErrorTypeResponse> {
    const rows = await this.database.db
      .select()
      .from(schema.errorTypes)
      .where(eq(schema.errorTypes.id, id))
      .limit(1);
    const existing = rows[0];
    if (!existing) throw new AppException(ERROR_CODES.TAG_NOT_FOUND, '找不到指定的錯誤類型。');

    // fallback 是「判斷不出錯因」時唯一的合法選項，停用它會逼 AI 亂猜一個具體錯誤。
    if (existing.isFallback && dto.status === 'deprecated') {
      throw new AppException(
        ERROR_CODES.CONFLICT,
        '「無法判定」是判斷不出錯因時的唯一合法選項，不可停用。',
      );
    }

    await this.database.db
      .update(schema.errorTypes)
      .set({
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description ?? null } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.errorTypes.id, id));

    const all = await this.listErrorTypes(true);
    return all.find((type) => type.id === id)!;
  }

  // ------------------------------------------------------------- helpers

  private async countSkillUsage(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.database.db
      .select({
        tagId: schema.questionSkillTags.skillTagId,
        total: sql<number>`count(*)::int`,
      })
      .from(schema.questionSkillTags)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.questionSkillTags.questionId))
      .where(and(inArray(schema.questionSkillTags.skillTagId, ids), isNull(schema.questions.deletedAt)))
      .groupBy(schema.questionSkillTags.skillTagId);
    return new Map(rows.map((row) => [row.tagId, row.total]));
  }

  private async countErrorTypeUsage(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.database.db
      .select({
        errorTypeId: schema.mistakeRecordErrorTypes.errorTypeId,
        total: sql<number>`count(*)::int`,
      })
      .from(schema.mistakeRecordErrorTypes)
      .where(inArray(schema.mistakeRecordErrorTypes.errorTypeId, ids))
      .groupBy(schema.mistakeRecordErrorTypes.errorTypeId);
    return new Map(rows.map((row) => [row.errorTypeId, row.total]));
  }

  private async loadAliases(
    tagKind: 'knowledge' | 'skill' | 'error_type',
    ids: string[],
  ): Promise<Map<string, string[]>> {
    if (ids.length === 0) return new Map();
    const rows = await this.database.db
      .select({ canonicalTagId: schema.tagAliases.canonicalTagId, alias: schema.tagAliases.alias })
      .from(schema.tagAliases)
      .where(
        and(eq(schema.tagAliases.tagKind, tagKind), inArray(schema.tagAliases.canonicalTagId, ids)),
      );

    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.canonicalTagId) ?? [];
      list.push(row.alias);
      map.set(row.canonicalTagId, list);
    }
    return map;
  }

  private translateDuplicate(error: unknown, message: string): unknown {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      return new AppException(ERROR_CODES.TAG_NAME_DUPLICATED, message);
    }
    return error;
  }
}
