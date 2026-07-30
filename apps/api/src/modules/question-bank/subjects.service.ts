import { Inject, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  type CreateSubjectRequest,
  type SubjectResponse,
  type UpdateSubjectRequest,
} from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { DATABASE } from '../../infra/infra.module';
import {
  countChaptersBySubject,
  countGroupsBySubject,
  countQuestionsBySubject,
} from './counts';

@Injectable()
export class SubjectsService {
  constructor(@Inject(DATABASE) private readonly database: DatabaseHandle) {}

  async list(userId: string): Promise<SubjectResponse[]> {
    const { db } = this.database;

    const rows = await db
      .select({
        id: schema.subjects.id,
        name: schema.subjects.name,
        code: schema.subjects.code,
        description: schema.subjects.description,
        sortOrder: schema.subjects.sortOrder,
        createdAt: schema.subjects.createdAt,
        updatedAt: schema.subjects.updatedAt,
      })
      .from(schema.subjects)
      .where(and(eq(schema.subjects.userId, userId), isNull(schema.subjects.deletedAt)))
      .orderBy(asc(schema.subjects.sortOrder), asc(schema.subjects.name));

    const ids = rows.map((row) => row.id);
    const [chapterCounts, groupCounts, questionCounts] = await Promise.all([
      countChaptersBySubject(db, ids),
      countGroupsBySubject(db, ids),
      countQuestionsBySubject(db, ids),
    ]);

    return rows.map((row) => ({
      ...row,
      chapterCount: chapterCounts.get(row.id) ?? 0,
      questionGroupCount: groupCounts.get(row.id) ?? 0,
      questionCount: questionCounts.get(row.id) ?? 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async getOrThrow(userId: string, id: string): Promise<SubjectResponse> {
    const found = (await this.list(userId)).find((s) => s.id === id);
    if (!found) {
      throw new AppException(ERROR_CODES.SUBJECT_NOT_FOUND, '找不到指定的科目。');
    }
    return found;
  }

  async create(userId: string, dto: CreateSubjectRequest): Promise<SubjectResponse> {
    const orderRows = await this.database.db
      .select({ nextOrder: sql<number>`coalesce(max(${schema.subjects.sortOrder}), -1) + 1` })
      .from(schema.subjects)
      .where(and(eq(schema.subjects.userId, userId), isNull(schema.subjects.deletedAt)));
    const nextOrder = orderRows[0]?.nextOrder ?? 0;

    try {
      const [created] = await this.database.db
        .insert(schema.subjects)
        .values({
          userId,
          name: dto.name,
          code: dto.code ?? null,
          description: dto.description ?? null,
          sortOrder: nextOrder ?? 0,
        })
        .returning({ id: schema.subjects.id });

      return this.getOrThrow(userId, created!.id);
    } catch (error) {
      throw this.translateUniqueViolation(error, '已有同名的科目。');
    }
  }

  async update(userId: string, id: string, dto: UpdateSubjectRequest): Promise<SubjectResponse> {
    await this.getOrThrow(userId, id);

    try {
      await this.database.db
        .update(schema.subjects)
        .set({
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.code !== undefined ? { code: dto.code ?? null } : {}),
          ...(dto.description !== undefined ? { description: dto.description ?? null } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(schema.subjects.id, id), eq(schema.subjects.userId, userId)));
    } catch (error) {
      throw this.translateUniqueViolation(error, '已有同名的科目。');
    }

    return this.getOrThrow(userId, id);
  }

  /**
   * 軟刪除科目，並連帶軟刪除其下的章節、題組與題目。
   *
   * 刻意不做硬刪除：歷史作答紀錄永遠指向題目，硬刪會破壞可追蹤性（規格 §20.19）。
   */
  async remove(userId: string, id: string): Promise<void> {
    await this.getOrThrow(userId, id);
    const now = new Date();

    await this.database.db.transaction(async (tx) => {
      await tx
        .update(schema.questions)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(schema.questions.subjectId, id), isNull(schema.questions.deletedAt)));

      await tx
        .update(schema.questionGroups)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(eq(schema.questionGroups.subjectId, id), isNull(schema.questionGroups.deletedAt)),
        );

      await tx
        .update(schema.chapters)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(schema.chapters.subjectId, id), isNull(schema.chapters.deletedAt)));

      await tx
        .update(schema.subjects)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(schema.subjects.id, id));
    });
  }

  async reorder(userId: string, orderedIds: string[]): Promise<SubjectResponse[]> {
    const owned = await this.database.db
      .select({ id: schema.subjects.id })
      .from(schema.subjects)
      .where(
        and(
          eq(schema.subjects.userId, userId),
          isNull(schema.subjects.deletedAt),
          inArray(schema.subjects.id, orderedIds),
        ),
      );

    if (owned.length !== orderedIds.length) {
      throw new AppException(
        ERROR_CODES.SUBJECT_NOT_FOUND,
        'orderedIds 中包含不存在或不屬於你的科目。',
      );
    }

    await this.database.db.transaction(async (tx) => {
      for (const [index, id] of orderedIds.entries()) {
        await tx
          .update(schema.subjects)
          .set({ sortOrder: index, updatedAt: new Date() })
          .where(and(eq(schema.subjects.id, id), eq(schema.subjects.userId, userId)));
      }
    });

    return this.list(userId);
  }

  /** PostgreSQL 23505 = unique_violation。轉成友善的 409，而不是回 500。 */
  private translateUniqueViolation(error: unknown, message: string): unknown {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      return new AppException(ERROR_CODES.CONFLICT, message);
    }
    return error;
  }
}
