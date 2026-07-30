import { Inject, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  type CreateQuestionGroupRequest,
  type ListQuestionGroupsQuery,
  type PaginationMeta,
  type QuestionGroupResponse,
  type UpdateQuestionGroupRequest,
} from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, asc, eq, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { DATABASE } from '../../infra/infra.module';
import { countQuestionsByGroup, countQuestionsForGroup } from './counts';
import { SubjectsService } from './subjects.service';

@Injectable()
export class QuestionGroupsService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    private readonly subjectsService: SubjectsService,
  ) {}

  async list(
    userId: string,
    query: ListQuestionGroupsQuery,
  ): Promise<{ items: QuestionGroupResponse[]; pagination: PaginationMeta }> {
    const conditions: SQL[] = [
      eq(schema.subjects.userId, userId),
      isNull(schema.questionGroups.deletedAt),
    ];

    if (query.subjectId) conditions.push(eq(schema.questionGroups.subjectId, query.subjectId));
    if (query.chapterId === 'none') {
      conditions.push(isNull(schema.questionGroups.chapterId));
    } else if (query.chapterId) {
      conditions.push(eq(schema.questionGroups.chapterId, query.chapterId));
    }
    if (query.q) conditions.push(ilike(schema.questionGroups.name, `%${query.q}%`));

    const where = and(...conditions);
    const { db } = this.database;

    const totalRows = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.questionGroups)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questionGroups.subjectId))
      .where(where);
    const total = totalRows[0]?.total ?? 0;

    const rows = await db
      .select({
        id: schema.questionGroups.id,
        subjectId: schema.questionGroups.subjectId,
        subjectName: schema.subjects.name,
        chapterId: schema.questionGroups.chapterId,
        chapterName: schema.chapters.name,
        name: schema.questionGroups.name,
        description: schema.questionGroups.description,
        source: schema.questionGroups.source,
        year: schema.questionGroups.year,
        notes: schema.questionGroups.notes,
        sortOrder: schema.questionGroups.sortOrder,
        createdAt: schema.questionGroups.createdAt,
        updatedAt: schema.questionGroups.updatedAt,
      })
      .from(schema.questionGroups)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questionGroups.subjectId))
      .leftJoin(schema.chapters, eq(schema.chapters.id, schema.questionGroups.chapterId))
      .where(where)
      .orderBy(asc(schema.questionGroups.sortOrder), asc(schema.questionGroups.name))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const questionCounts = await countQuestionsByGroup(
      db,
      rows.map((row) => row.id),
    );

    return {
      items: rows.map((row) => ({
        ...row,
        questionCount: questionCounts.get(row.id) ?? 0,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total: total ?? 0,
        totalPages: Math.max(1, Math.ceil((total ?? 0) / query.pageSize)),
      },
    };
  }

  async create(
    userId: string,
    dto: CreateQuestionGroupRequest,
  ): Promise<QuestionGroupResponse> {
    await this.subjectsService.getOrThrow(userId, dto.subjectId);
    if (dto.chapterId) await this.assertChapterInSubject(dto.chapterId, dto.subjectId);

    const orderRows = await this.database.db
      .select({ nextOrder: sql<number>`coalesce(max(${schema.questionGroups.sortOrder}), -1) + 1` })
      .from(schema.questionGroups)
      .where(
        and(
          eq(schema.questionGroups.subjectId, dto.subjectId),
          isNull(schema.questionGroups.deletedAt),
        ),
      );
    const nextOrder = orderRows[0]?.nextOrder ?? 0;

    const [created] = await this.database.db
      .insert(schema.questionGroups)
      .values({
        subjectId: dto.subjectId,
        chapterId: dto.chapterId ?? null,
        name: dto.name,
        description: dto.description ?? null,
        source: dto.source ?? null,
        year: dto.year ?? null,
        notes: dto.notes ?? null,
        sortOrder: nextOrder ?? 0,
      })
      .returning({ id: schema.questionGroups.id });

    return this.findByIdOrThrow(userId, created!.id);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateQuestionGroupRequest,
  ): Promise<QuestionGroupResponse> {
    const existing = await this.findByIdOrThrow(userId, id);

    if (dto.chapterId !== undefined && dto.chapterId !== null) {
      await this.assertChapterInSubject(dto.chapterId, existing.subjectId);
    }

    await this.database.db
      .update(schema.questionGroups)
      .set({
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.chapterId !== undefined ? { chapterId: dto.chapterId ?? null } : {}),
        ...(dto.description !== undefined ? { description: dto.description ?? null } : {}),
        ...(dto.source !== undefined ? { source: dto.source ?? null } : {}),
        ...(dto.year !== undefined ? { year: dto.year ?? null } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes ?? null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.questionGroups.id, id));

    // 題目的 chapter_id 為反正規化欄位，需同步維持一致。
    if (dto.chapterId !== undefined) {
      await this.database.db
        .update(schema.questions)
        .set({ chapterId: dto.chapterId ?? null, updatedAt: new Date() })
        .where(eq(schema.questions.questionGroupId, id));
    }

    return this.findByIdOrThrow(userId, id);
  }

  /** 軟刪除題組，並連帶軟刪除其題目（題目不能沒有題組）。 */
  async remove(userId: string, id: string): Promise<void> {
    await this.findByIdOrThrow(userId, id);
    const now = new Date();

    await this.database.db.transaction(async (tx) => {
      await tx
        .update(schema.questions)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.questions.questionGroupId, id),
            isNull(schema.questions.deletedAt),
          ),
        );

      await tx
        .update(schema.questionGroups)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(schema.questionGroups.id, id));
    });
  }

  async reorder(userId: string, orderedIds: string[]): Promise<void> {
    const owned = await this.database.db
      .select({ id: schema.questionGroups.id })
      .from(schema.questionGroups)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questionGroups.subjectId))
      .where(
        and(
          eq(schema.subjects.userId, userId),
          isNull(schema.questionGroups.deletedAt),
          inArray(schema.questionGroups.id, orderedIds),
        ),
      );

    if (owned.length !== orderedIds.length) {
      throw new AppException(
        ERROR_CODES.QUESTION_GROUP_NOT_FOUND,
        'orderedIds 中包含不存在或不屬於你的題組。',
      );
    }

    await this.database.db.transaction(async (tx) => {
      for (const [index, id] of orderedIds.entries()) {
        await tx
          .update(schema.questionGroups)
          .set({ sortOrder: index, updatedAt: new Date() })
          .where(eq(schema.questionGroups.id, id));
      }
    });
  }

  /** 依 ID 取單一題組（重用 list 的欄位組合，避免兩處維護同一份投影）。 */
  async findByIdOrThrow(userId: string, id: string): Promise<QuestionGroupResponse> {
    const rows = await this.database.db
      .select({
        id: schema.questionGroups.id,
        subjectId: schema.questionGroups.subjectId,
        subjectName: schema.subjects.name,
        chapterId: schema.questionGroups.chapterId,
        chapterName: schema.chapters.name,
        name: schema.questionGroups.name,
        description: schema.questionGroups.description,
        source: schema.questionGroups.source,
        year: schema.questionGroups.year,
        notes: schema.questionGroups.notes,
        sortOrder: schema.questionGroups.sortOrder,
        createdAt: schema.questionGroups.createdAt,
        updatedAt: schema.questionGroups.updatedAt,
      })
      .from(schema.questionGroups)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questionGroups.subjectId))
      .leftJoin(schema.chapters, eq(schema.chapters.id, schema.questionGroups.chapterId))
      .where(
        and(
          eq(schema.questionGroups.id, id),
          eq(schema.subjects.userId, userId),
          isNull(schema.questionGroups.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new AppException(ERROR_CODES.QUESTION_GROUP_NOT_FOUND, '找不到指定的題組。');
    }

    return {
      ...row,
      questionCount: await countQuestionsForGroup(this.database.db, row.id),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * 章節必須屬於同一科目。
   *
   * 資料庫的複合外鍵已經保證這件事，這裡先檢查是為了回傳明確的錯誤碼，
   * 而不是讓使用者看到資料庫層的外鍵違規訊息。
   */
  private async assertChapterInSubject(chapterId: string, subjectId: string): Promise<void> {
    const [chapter] = await this.database.db
      .select({ subjectId: schema.chapters.subjectId })
      .from(schema.chapters)
      .where(and(eq(schema.chapters.id, chapterId), isNull(schema.chapters.deletedAt)))
      .limit(1);

    if (!chapter) {
      throw new AppException(ERROR_CODES.CHAPTER_NOT_FOUND, '找不到指定的章節。');
    }
    if (chapter.subjectId !== subjectId) {
      throw new AppException(
        ERROR_CODES.CHAPTER_SUBJECT_MISMATCH,
        '指定的章節不屬於此科目。',
      );
    }
  }
}
