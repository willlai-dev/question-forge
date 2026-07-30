import { Inject, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  type ChapterResponse,
  type CreateChapterRequest,
  type UpdateChapterRequest,
} from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { DATABASE } from '../../infra/infra.module';
import { countGroupsByChapter, countQuestionsByChapter } from './counts';
import { SubjectsService } from './subjects.service';

@Injectable()
export class ChaptersService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    private readonly subjectsService: SubjectsService,
  ) {}

  async list(userId: string, subjectId: string): Promise<ChapterResponse[]> {
    // 先確認科目屬於此使用者，避免以他人的 subjectId 探測資料。
    await this.subjectsService.getOrThrow(userId, subjectId);

    const { db } = this.database;

    const rows = await db
      .select({
        id: schema.chapters.id,
        subjectId: schema.chapters.subjectId,
        name: schema.chapters.name,
        description: schema.chapters.description,
        sortOrder: schema.chapters.sortOrder,
        createdAt: schema.chapters.createdAt,
        updatedAt: schema.chapters.updatedAt,
      })
      .from(schema.chapters)
      .where(and(eq(schema.chapters.subjectId, subjectId), isNull(schema.chapters.deletedAt)))
      .orderBy(asc(schema.chapters.sortOrder), asc(schema.chapters.name));

    const ids = rows.map((row) => row.id);
    const [groupCounts, questionCounts] = await Promise.all([
      countGroupsByChapter(db, ids),
      countQuestionsByChapter(db, ids),
    ]);

    return rows.map((row) => ({
      ...row,
      questionGroupCount: groupCounts.get(row.id) ?? 0,
      questionCount: questionCounts.get(row.id) ?? 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async getOrThrow(userId: string, id: string): Promise<ChapterResponse> {
    const [row] = await this.database.db
      .select({ subjectId: schema.chapters.subjectId })
      .from(schema.chapters)
      .where(and(eq(schema.chapters.id, id), isNull(schema.chapters.deletedAt)))
      .limit(1);

    if (!row) throw new AppException(ERROR_CODES.CHAPTER_NOT_FOUND, '找不到指定的章節。');

    const found = (await this.list(userId, row.subjectId)).find((c) => c.id === id);
    if (!found) throw new AppException(ERROR_CODES.CHAPTER_NOT_FOUND, '找不到指定的章節。');
    return found;
  }

  async create(userId: string, dto: CreateChapterRequest): Promise<ChapterResponse> {
    await this.subjectsService.getOrThrow(userId, dto.subjectId);

    const orderRows = await this.database.db
      .select({ nextOrder: sql<number>`coalesce(max(${schema.chapters.sortOrder}), -1) + 1` })
      .from(schema.chapters)
      .where(and(eq(schema.chapters.subjectId, dto.subjectId), isNull(schema.chapters.deletedAt)));
    const nextOrder = orderRows[0]?.nextOrder ?? 0;

    try {
      const [created] = await this.database.db
        .insert(schema.chapters)
        .values({
          subjectId: dto.subjectId,
          name: dto.name,
          description: dto.description ?? null,
          sortOrder: nextOrder ?? 0,
        })
        .returning({ id: schema.chapters.id });

      return this.getOrThrow(userId, created!.id);
    } catch (error) {
      throw this.translateUniqueViolation(error);
    }
  }

  async update(userId: string, id: string, dto: UpdateChapterRequest): Promise<ChapterResponse> {
    await this.getOrThrow(userId, id);

    try {
      await this.database.db
        .update(schema.chapters)
        .set({
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description ?? null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.chapters.id, id));
    } catch (error) {
      throw this.translateUniqueViolation(error);
    }

    return this.getOrThrow(userId, id);
  }

  /**
   * 軟刪除章節。
   *
   * 刻意「不」連帶刪除底下的題組與題目 —— 章節只是分類層，
   * 刪掉分類不應該讓內容消失。題組會退回直接隸屬科目（chapter_id 設為 NULL），
   * 這正是資料模型允許章節為空的用途（FR-CAT-03）。
   */
  async remove(userId: string, id: string): Promise<void> {
    await this.getOrThrow(userId, id);
    const now = new Date();

    await this.database.db.transaction(async (tx) => {
      await tx
        .update(schema.questions)
        .set({ chapterId: null, updatedAt: now })
        .where(eq(schema.questions.chapterId, id));

      await tx
        .update(schema.questionGroups)
        .set({ chapterId: null, updatedAt: now })
        .where(eq(schema.questionGroups.chapterId, id));

      await tx
        .update(schema.chapters)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(schema.chapters.id, id));
    });
  }

  async reorder(
    userId: string,
    subjectId: string,
    orderedIds: string[],
  ): Promise<ChapterResponse[]> {
    await this.subjectsService.getOrThrow(userId, subjectId);

    const owned = await this.database.db
      .select({ id: schema.chapters.id })
      .from(schema.chapters)
      .where(
        and(
          eq(schema.chapters.subjectId, subjectId),
          isNull(schema.chapters.deletedAt),
          inArray(schema.chapters.id, orderedIds),
        ),
      );

    if (owned.length !== orderedIds.length) {
      throw new AppException(
        ERROR_CODES.CHAPTER_NOT_FOUND,
        'orderedIds 中包含不存在或不屬於此科目的章節。',
      );
    }

    await this.database.db.transaction(async (tx) => {
      for (const [index, id] of orderedIds.entries()) {
        await tx
          .update(schema.chapters)
          .set({ sortOrder: index, updatedAt: new Date() })
          .where(eq(schema.chapters.id, id));
      }
    });

    return this.list(userId, subjectId);
  }

  private translateUniqueViolation(error: unknown): unknown {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      return new AppException(ERROR_CODES.CONFLICT, '同一科目下已有同名的章節。');
    }
    return error;
  }
}
