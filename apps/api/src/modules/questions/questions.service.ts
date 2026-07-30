import { Inject, Injectable } from '@nestjs/common';
import { computeQuestionContentHash } from '@repo/contracts/server';
import {
  ERROR_CODES,
  type BulkQuestionAction,
  type CreateQuestionRequest,
  type ListQuestionsQuery,
  type PaginationMeta,
  type QuestionResponse,
  type QuestionVersionResponse,
  type UpdateQuestionRequest,
} from '@repo/contracts';
import { schema, type Database, type DatabaseHandle } from '@repo/db';
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { DATABASE } from '../../infra/infra.module';

type QuestionRow = typeof schema.questions.$inferSelect;

@Injectable()
export class QuestionsService {
  constructor(@Inject(DATABASE) private readonly database: DatabaseHandle) {}

  async list(
    userId: string,
    query: ListQuestionsQuery,
  ): Promise<{ items: QuestionResponse[]; pagination: PaginationMeta }> {
    const { db } = this.database;
    const conditions: SQL[] = [
      eq(schema.questions.userId, userId),
      isNull(schema.questions.deletedAt),
    ];

    if (query.subjectId) conditions.push(eq(schema.questions.subjectId, query.subjectId));
    if (query.questionGroupId)
      conditions.push(eq(schema.questions.questionGroupId, query.questionGroupId));
    if (query.chapterId === 'none') conditions.push(isNull(schema.questions.chapterId));
    else if (query.chapterId) conditions.push(eq(schema.questions.chapterId, query.chapterId));
    if (query.type) conditions.push(eq(schema.questions.type, query.type));
    if (query.status) conditions.push(eq(schema.questions.status, query.status));
    if (query.reviewRequired)
      conditions.push(eq(schema.questions.reviewRequired, query.reviewRequired === 'true'));
    if (query.hasExplanation === 'true') conditions.push(isNotNull(schema.questions.explanation));
    if (query.hasExplanation === 'false') conditions.push(isNull(schema.questions.explanation));
    if (query.q) conditions.push(ilike(schema.questions.stem, `%${query.q}%`));

    const where = and(...conditions);

    const totalRows = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.questions)
      .where(where);
    const total = totalRows[0]?.total ?? 0;

    const sortColumn = {
      number: schema.questions.questionNumber,
      created: schema.questions.createdAt,
      updated: schema.questions.updatedAt,
    }[query.sort];
    const direction = query.order === 'desc' ? desc : asc;

    const rows = await db
      .select()
      .from(schema.questions)
      .where(where)
      .orderBy(direction(sortColumn), asc(schema.questions.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      items: await this.hydrate(db, rows),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  }

  async getOrThrow(userId: string, id: string): Promise<QuestionResponse> {
    const rows = await this.database.db
      .select()
      .from(schema.questions)
      .where(
        and(
          eq(schema.questions.id, id),
          eq(schema.questions.userId, userId),
          isNull(schema.questions.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppException(ERROR_CODES.QUESTION_NOT_FOUND, '找不到指定的題目。');

    const [hydrated] = await this.hydrate(this.database.db, [row]);
    return hydrated!;
  }

  async create(userId: string, dto: CreateQuestionRequest): Promise<QuestionResponse> {
    const group = await this.resolveGroup(userId, dto.questionGroupId);
    const contentHash = computeQuestionContentHash({
      type: dto.type,
      stem: dto.stem,
      options: dto.options,
    });

    const id = await this.database.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.questions)
        .values({
          userId,
          questionGroupId: group.id,
          subjectId: group.subjectId,
          chapterId: group.chapterId,
          questionNumber: dto.questionNumber,
          type: dto.type,
          stem: dto.stem,
          explanation: dto.explanation ?? null,
          sourcePage: dto.sourcePage ?? null,
          sourceReference: dto.sourceReference ?? null,
          reviewRequired: dto.reviewRequired,
          reviewReason: dto.reviewReason ?? null,
          contentHash,
        })
        .returning({ id: schema.questions.id })
        .catch((error: unknown) => {
          throw this.translateUnique(error);
        });

      const questionId = inserted[0]!.id;
      await tx.insert(schema.questionOptions).values(
        dto.options.map((option, index) => ({
          questionId,
          key: option.key,
          text: option.text,
          isCorrect: option.isCorrect,
          sortOrder: index,
        })),
      );

      await this.writeVersion(tx, questionId, 1, dto, contentHash, userId, '建立題目');
      return questionId;
    });

    return this.getOrThrow(userId, id);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateQuestionRequest,
  ): Promise<QuestionResponse> {
    const existing = await this.getOrThrow(userId, id);
    const contentHash = computeQuestionContentHash({
      type: dto.type,
      stem: dto.stem,
      options: dto.options,
    });

    const changedFields: string[] = [];
    if (existing.stem !== dto.stem) changedFields.push('stem');
    if (existing.type !== dto.type) changedFields.push('type');
    if (existing.explanation !== (dto.explanation ?? null)) changedFields.push('explanation');
    if (existing.contentHash !== contentHash) changedFields.push('options');

    const nextVersion = existing.currentVersion + 1;

    await this.database.db.transaction(async (tx) => {
      await tx
        .update(schema.questions)
        .set({
          questionNumber: dto.questionNumber,
          type: dto.type,
          stem: dto.stem,
          explanation: dto.explanation ?? null,
          sourcePage: dto.sourcePage ?? null,
          sourceReference: dto.sourceReference ?? null,
          reviewRequired: dto.reviewRequired,
          reviewReason: dto.reviewReason ?? null,
          contentHash,
          currentVersion: nextVersion,
          updatedAt: new Date(),
        })
        .where(eq(schema.questions.id, id))
        .catch((error: unknown) => {
          throw this.translateUnique(error);
        });

      // 選項整組換掉：選項是題目的一部分，逐一 diff 沒有實益。
      await tx.delete(schema.questionOptions).where(eq(schema.questionOptions.questionId, id));
      await tx.insert(schema.questionOptions).values(
        dto.options.map((option, index) => ({
          questionId: id,
          key: option.key,
          text: option.text,
          isCorrect: option.isCorrect,
          sortOrder: index,
        })),
      );

      await this.writeVersion(tx, id, nextVersion, dto, contentHash, userId, '更新題目', changedFields);
    });

    return this.getOrThrow(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.getOrThrow(userId, id);
    await this.database.db
      .update(schema.questions)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.questions.id, id));
  }

  async bulk(userId: string, dto: BulkQuestionAction): Promise<{ affected: number }> {
    const { db } = this.database;

    const owned = await db
      .select({ id: schema.questions.id })
      .from(schema.questions)
      .where(
        and(
          eq(schema.questions.userId, userId),
          isNull(schema.questions.deletedAt),
          inArray(schema.questions.id, dto.questionIds),
        ),
      );

    if (owned.length !== dto.questionIds.length) {
      throw new AppException(
        ERROR_CODES.QUESTION_NOT_FOUND,
        'questionIds 中包含不存在或不屬於你的題目。',
      );
    }

    const ids = owned.map((row) => row.id);
    const now = new Date();

    if (dto.action === 'delete') {
      await db
        .update(schema.questions)
        .set({ deletedAt: now, updatedAt: now })
        .where(inArray(schema.questions.id, ids));
      return { affected: ids.length };
    }

    if (dto.action === 'setReviewRequired') {
      await db
        .update(schema.questions)
        .set({ reviewRequired: dto.reviewRequired!, updatedAt: now })
        .where(inArray(schema.questions.id, ids));
      return { affected: ids.length };
    }

    // move：同時維護反正規化的 subjectId / chapterId，否則列表篩選會失準。
    const group = await this.resolveGroup(userId, dto.targetQuestionGroupId!);
    await db
      .update(schema.questions)
      .set({
        questionGroupId: group.id,
        subjectId: group.subjectId,
        chapterId: group.chapterId,
        updatedAt: now,
      })
      .where(inArray(schema.questions.id, ids))
      .catch((error: unknown) => {
        throw this.translateUnique(error);
      });

    return { affected: ids.length };
  }

  async versions(userId: string, id: string): Promise<QuestionVersionResponse[]> {
    await this.getOrThrow(userId, id);
    const rows = await this.database.db
      .select({
        id: schema.questionVersions.id,
        version: schema.questionVersions.version,
        contentHash: schema.questionVersions.contentHash,
        changedFields: schema.questionVersions.changedFields,
        changeReason: schema.questionVersions.changeReason,
        createdAt: schema.questionVersions.createdAt,
      })
      .from(schema.questionVersions)
      .where(eq(schema.questionVersions.questionId, id))
      .orderBy(desc(schema.questionVersions.version));

    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  // ------------------------------------------------------------- helpers

  /** 把題目列補上選項與階層名稱。 */
  private async hydrate(db: Database, rows: QuestionRow[]): Promise<QuestionResponse[]> {
    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.id);
    const options = await db
      .select()
      .from(schema.questionOptions)
      .where(inArray(schema.questionOptions.questionId, ids))
      .orderBy(asc(schema.questionOptions.sortOrder));

    const groupIds = [...new Set(rows.map((row) => row.questionGroupId))];
    const groups = await db
      .select({
        id: schema.questionGroups.id,
        name: schema.questionGroups.name,
        subjectName: schema.subjects.name,
        chapterName: schema.chapters.name,
      })
      .from(schema.questionGroups)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questionGroups.subjectId))
      .leftJoin(schema.chapters, eq(schema.chapters.id, schema.questionGroups.chapterId))
      .where(inArray(schema.questionGroups.id, groupIds));

    const groupMap = new Map(groups.map((g) => [g.id, g]));
    const optionMap = new Map<string, typeof options>();
    for (const option of options) {
      const list = optionMap.get(option.questionId) ?? [];
      list.push(option);
      optionMap.set(option.questionId, list);
    }

    return rows.map((row) => {
      const group = groupMap.get(row.questionGroupId);
      return {
        id: row.id,
        questionGroupId: row.questionGroupId,
        questionGroupName: group?.name ?? '',
        subjectId: row.subjectId,
        subjectName: group?.subjectName ?? '',
        chapterId: row.chapterId,
        chapterName: group?.chapterName ?? null,
        externalId: row.externalId,
        questionNumber: row.questionNumber,
        type: row.type,
        stem: row.stem,
        options: (optionMap.get(row.id) ?? []).map((option) => ({
          id: option.id,
          key: option.key,
          text: option.text,
          isCorrect: option.isCorrect,
          sortOrder: option.sortOrder,
        })),
        explanation: row.explanation,
        sourcePage: row.sourcePage,
        sourceReference: row.sourceReference,
        reviewRequired: row.reviewRequired,
        reviewReason: row.reviewReason,
        status: row.status as QuestionResponse['status'],
        currentVersion: row.currentVersion,
        contentHash: row.contentHash,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  private async resolveGroup(
    userId: string,
    groupId: string,
  ): Promise<{ id: string; subjectId: string; chapterId: string | null }> {
    const rows = await this.database.db
      .select({
        id: schema.questionGroups.id,
        subjectId: schema.questionGroups.subjectId,
        chapterId: schema.questionGroups.chapterId,
      })
      .from(schema.questionGroups)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questionGroups.subjectId))
      .where(
        and(
          eq(schema.questionGroups.id, groupId),
          eq(schema.subjects.userId, userId),
          isNull(schema.questionGroups.deletedAt),
        ),
      )
      .limit(1);

    const group = rows[0];
    if (!group) {
      throw new AppException(ERROR_CODES.QUESTION_GROUP_NOT_FOUND, '找不到指定的題組。');
    }
    return group;
  }

  private async writeVersion(
    tx: Database,
    questionId: string,
    version: number,
    dto: CreateQuestionRequest | UpdateQuestionRequest,
    contentHash: string,
    userId: string,
    reason: string,
    changedFields?: string[],
  ): Promise<void> {
    await tx.insert(schema.questionVersions).values({
      questionId,
      version,
      contentHash,
      snapshot: {
        type: dto.type,
        stem: dto.stem,
        options: dto.options,
        explanation: dto.explanation ?? null,
        questionNumber: dto.questionNumber,
        sourcePage: dto.sourcePage ?? null,
        sourceReference: dto.sourceReference ?? null,
      },
      changedFields: changedFields ?? null,
      changeReason: reason,
      createdBy: userId,
    });
  }

  private translateUnique(error: unknown): unknown {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      return new AppException(ERROR_CODES.CONFLICT, '同一題組中已有相同題號的題目。');
    }
    return error;
  }
}
