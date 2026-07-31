import { Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, type SetMistakeErrorTypesRequest } from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { DATABASE } from '../../infra/infra.module';

/**
 * 錯題的錯誤類型標記（FR-MIS-02）。
 *
 * Phase 3 由使用者手動標記；Phase 4 的 AI 分析會寫入同一張表並以 `source = 'ai'` 區分。
 * 先把讀寫路徑做起來，錯題本的「依錯誤類型篩選」在接上 AI 之前就已經可用。
 */
@Injectable()
export class MistakeErrorTypesService {
  constructor(@Inject(DATABASE) private readonly database: DatabaseHandle) {}

  async set(userId: string, questionId: string, dto: SetMistakeErrorTypesRequest): Promise<void> {
    const rows = await this.database.db
      .select({ id: schema.mistakeRecords.id })
      .from(schema.mistakeRecords)
      .where(
        and(
          eq(schema.mistakeRecords.userId, userId),
          eq(schema.mistakeRecords.questionId, questionId),
        ),
      )
      .limit(1);

    const record = rows[0];
    if (!record) throw new AppException(ERROR_CODES.NOT_FOUND, '錯題本中沒有這一題。');

    if (dto.errorTypeIds.length > 0) {
      const found = await this.database.db
        .select({ id: schema.errorTypes.id })
        .from(schema.errorTypes)
        .where(inArray(schema.errorTypes.id, dto.errorTypeIds));
      if (found.length !== new Set(dto.errorTypeIds).size) {
        throw new AppException(ERROR_CODES.TAG_NOT_FOUND, '指定的錯誤類型不存在。');
      }
    }

    await this.database.db.transaction(async (tx) => {
      // 只換掉手動標記，保留 AI 寫入的部分 ——
      // 使用者調整自己的判斷時，不應該把 AI 的診斷一起抹掉。
      await tx
        .delete(schema.mistakeRecordErrorTypes)
        .where(
          and(
            eq(schema.mistakeRecordErrorTypes.mistakeRecordId, record.id),
            eq(schema.mistakeRecordErrorTypes.source, 'manual'),
          ),
        );

      if (dto.errorTypeIds.length > 0) {
        await tx
          .insert(schema.mistakeRecordErrorTypes)
          .values(
            dto.errorTypeIds.map((errorTypeId) => ({
              mistakeRecordId: record.id,
              errorTypeId,
              source: 'manual',
            })),
          )
          // 同一個錯誤類型已由 AI 標記時保留原列，只是現在也有人工認可。
          .onConflictDoNothing();
      }

      await tx
        .update(schema.mistakeRecords)
        .set({ lastErrorTypeId: dto.errorTypeIds[0] ?? null, updatedAt: new Date() })
        .where(eq(schema.mistakeRecords.id, record.id));
    });
  }
}
