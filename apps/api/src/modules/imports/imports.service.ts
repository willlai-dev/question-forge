import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { computeNoteContentHash, computeQuestionContentHash } from '@repo/contracts/server';
import {
  ERROR_CODES,
  validateImportFile,
  type CommitImportRequest,
  type CommitImportResult,
  type Env,
  type FixImportQuestionRequest,
  type ImportBatchResponse,
  type ImportQuestionResponse,
  type ImportValidationContext,
  type NormalizedImportQuestion,
} from '@repo/contracts';
import { schema, type Database, type DatabaseHandle } from '@repo/db';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { ENV } from '../../config/env.config';
import { DATABASE } from '../../infra/infra.module';

/** 可 commit 的暫存題目狀態（error 與 excluded 不寫入正式題庫）。 */
const COMMITTABLE_STATUSES = ['valid', 'warning', 'fixed'] as const;

@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * 上傳並驗證。
   *
   * 關鍵原則（FR-IMP-03）：這一步「只」寫入暫存區，
   * 正式的 questions 資料表在使用者確認 commit 前完全不會被觸碰。
   */
  async createBatch(
    userId: string,
    file: { originalname: string; size: number; buffer: Buffer },
  ): Promise<ImportBatchResponse> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.buffer.toString('utf8'));
    } catch (error) {
      throw new AppException(
        ERROR_CODES.IMPORT_FILE_INVALID_JSON,
        `檔案不是合法的 JSON：${error instanceof Error ? error.message : '解析失敗'}`,
      );
    }

    const context = await this.buildValidationContext(userId, null);
    const result = validateImportFile(parsed, context);

    const fileObject = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<
      string,
      unknown
    >;
    const schemaVersion =
      typeof fileObject.schemaVersion === 'string' ? fileObject.schemaVersion : null;

    const batchId = await this.database.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.importBatches)
        .values({
          userId,
          filename: file.originalname,
          fileSize: file.size,
          fileHash: createHash('sha256').update(file.buffer).digest('hex'),
          schemaVersion,
          status: result.fileIssues.some((i) => i.level === 'error')
            ? 'failed'
            : result.errorCount > 0
              ? 'partially_valid'
              : 'validated',
          totalCount: result.rows.length,
          validCount: result.validCount,
          errorCount: result.errorCount,
          warningCount: result.warningCount,
          reviewRequiredCount: result.reviewRequiredCount,
          noteCount: result.notes.length,
          rawPayload: parsed as object,
          errorSummary: { fileIssues: result.fileIssues },
          validatedAt: new Date(),
        })
        .returning({ id: schema.importBatches.id });

      const id = inserted[0]!.id;
      await this.persistRows(tx, id, result.rows);
      return id;
    });

    return this.getBatch(userId, batchId);
  }

  async listBatches(userId: string): Promise<ImportBatchResponse[]> {
    const rows = await this.database.db
      .select({ id: schema.importBatches.id })
      .from(schema.importBatches)
      .where(eq(schema.importBatches.userId, userId))
      .orderBy(desc(schema.importBatches.createdAt))
      .limit(50);

    return Promise.all(rows.map((row) => this.getBatch(userId, row.id)));
  }

  async getBatch(userId: string, batchId: string): Promise<ImportBatchResponse> {
    const rows = await this.database.db
      .select({
        batch: schema.importBatches,
        subjectName: schema.subjects.name,
        chapterName: schema.chapters.name,
        groupName: schema.questionGroups.name,
      })
      .from(schema.importBatches)
      .leftJoin(schema.subjects, eq(schema.subjects.id, schema.importBatches.targetSubjectId))
      .leftJoin(schema.chapters, eq(schema.chapters.id, schema.importBatches.targetChapterId))
      .leftJoin(
        schema.questionGroups,
        eq(schema.questionGroups.id, schema.importBatches.targetGroupId),
      )
      .where(
        and(eq(schema.importBatches.id, batchId), eq(schema.importBatches.userId, userId)),
      )
      .limit(1);

    const found = rows[0];
    if (!found) {
      throw new AppException(ERROR_CODES.IMPORT_BATCH_NOT_FOUND, '找不到指定的匯入批次。');
    }

    const batch = found.batch;
    const fileIssues =
      (batch.errorSummary as { fileIssues?: { level: 'error' | 'warning'; code: string; message: string }[] } | null)
        ?.fileIssues ?? [];

    const blockingRows = await this.database.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.importQuestions)
      .where(
        and(
          eq(schema.importQuestions.batchId, batchId),
          eq(schema.importQuestions.status, 'error'),
        ),
      );
    const blockingCount = blockingRows[0]?.n ?? 0;

    const canCommit =
      batch.status !== 'committed' &&
      batch.status !== 'discarded' &&
      fileIssues.every((i) => i.level !== 'error') &&
      blockingCount === 0 &&
      batch.totalCount > 0;

    return {
      id: batch.id,
      filename: batch.filename,
      fileSize: batch.fileSize,
      schemaVersion: batch.schemaVersion,
      status: batch.status as ImportBatchResponse['status'],
      targetSubjectId: batch.targetSubjectId,
      targetSubjectName: found.subjectName,
      targetChapterId: batch.targetChapterId,
      targetChapterName: found.chapterName,
      targetGroupId: batch.targetGroupId,
      targetGroupName: found.groupName,
      totalCount: batch.totalCount,
      validCount: batch.validCount,
      errorCount: batch.errorCount,
      warningCount: batch.warningCount,
      reviewRequiredCount: batch.reviewRequiredCount,
      committedCount: batch.committedCount,
      noteCount: batch.noteCount,
      fileIssues,
      canCommit,
      validatedAt: batch.validatedAt?.toISOString() ?? null,
      committedAt: batch.committedAt?.toISOString() ?? null,
      createdAt: batch.createdAt.toISOString(),
    };
  }

  async listBatchQuestions(
    userId: string,
    batchId: string,
    status?: string,
  ): Promise<ImportQuestionResponse[]> {
    await this.getBatch(userId, batchId);

    const conditions = [eq(schema.importQuestions.batchId, batchId)];
    if (status) conditions.push(eq(schema.importQuestions.status, status));

    const rows = await this.database.db
      .select()
      .from(schema.importQuestions)
      .where(and(...conditions))
      .orderBy(asc(schema.importQuestions.rowIndex));

    const issues = await this.database.db
      .select()
      .from(schema.importValidationIssues)
      .where(eq(schema.importValidationIssues.batchId, batchId));

    const issueMap = new Map<string, typeof issues>();
    for (const item of issues) {
      if (!item.importQuestionId) continue;
      const list = issueMap.get(item.importQuestionId) ?? [];
      list.push(item);
      issueMap.set(item.importQuestionId, list);
    }

    return rows.map((row) => ({
      id: row.id,
      rowIndex: row.rowIndex,
      externalId: row.externalId,
      questionNumber: row.questionNumber,
      type: row.type,
      stem: row.stem,
      options: (row.options as ImportQuestionResponse['options']) ?? null,
      explanation: row.explanation,
      sourcePage: row.sourcePage,
      sourceReference: row.sourceReference,
      reviewRequired: row.reviewRequired,
      reviewReason: row.reviewReason,
      status: row.status as ImportQuestionResponse['status'],
      issues: (issueMap.get(row.id) ?? []).map((i) => ({
        level: i.level as 'error' | 'warning',
        code: i.code,
        message: i.message,
        fieldPath: i.fieldPath,
      })),
      resultingQuestionId: row.resultingQuestionId,
    }));
  }

  /** 在預覽頁修正單題後，重新驗證整批（批次內重複偵測需要全域視野）。 */
  async fixQuestion(
    userId: string,
    batchId: string,
    importQuestionId: string,
    dto: FixImportQuestionRequest,
  ): Promise<ImportBatchResponse> {
    await this.assertBatchMutable(userId, batchId);

    const rows = await this.database.db
      .select()
      .from(schema.importQuestions)
      .where(
        and(
          eq(schema.importQuestions.id, importQuestionId),
          eq(schema.importQuestions.batchId, batchId),
        ),
      )
      .limit(1);

    if (!rows[0]) {
      throw new AppException(ERROR_CODES.NOT_FOUND, '找不到指定的暫存題目。');
    }

    await this.database.db
      .update(schema.importQuestions)
      .set({
        ...(dto.questionNumber !== undefined ? { questionNumber: dto.questionNumber ?? null } : {}),
        ...(dto.type !== undefined ? { type: dto.type ?? null } : {}),
        ...(dto.stem !== undefined ? { stem: dto.stem ?? null } : {}),
        // 選項代號一律轉大寫。驗證階段對小寫代號只發 warning 並說「會統一成大寫」，
        // 但修正端點原本原樣存回，於是那句承諾在使用者手動修正後就跳票了。
        ...(dto.options !== undefined
          ? {
              options:
                dto.options?.map((option) => ({ ...option, key: option.key.trim().toUpperCase() })) ??
                null,
            }
          : {}),
        ...(dto.explanation !== undefined ? { explanation: dto.explanation ?? null } : {}),
        ...(dto.sourcePage !== undefined ? { sourcePage: dto.sourcePage ?? null } : {}),
        ...(dto.sourceReference !== undefined
          ? { sourceReference: dto.sourceReference ?? null }
          : {}),
        ...(dto.reviewRequired !== undefined ? { reviewRequired: dto.reviewRequired ?? false } : {}),
        ...(dto.reviewReason !== undefined ? { reviewReason: dto.reviewReason ?? null } : {}),
        editedPayload: dto as object,
        updatedAt: new Date(),
      })
      .where(eq(schema.importQuestions.id, importQuestionId));

    return this.revalidate(userId, batchId);
  }

  async excludeQuestion(
    userId: string,
    batchId: string,
    importQuestionId: string,
  ): Promise<ImportBatchResponse> {
    await this.assertBatchMutable(userId, batchId);

    await this.database.db
      .update(schema.importQuestions)
      .set({ status: 'excluded', updatedAt: new Date() })
      .where(
        and(
          eq(schema.importQuestions.id, importQuestionId),
          eq(schema.importQuestions.batchId, batchId),
        ),
      );

    return this.recountBatch(userId, batchId);
  }

  /** 以暫存區目前的內容重新跑一次完整驗證。 */
  async revalidate(userId: string, batchId: string): Promise<ImportBatchResponse> {
    await this.assertBatchMutable(userId, batchId);

    const staged = await this.database.db
      .select()
      .from(schema.importQuestions)
      .where(eq(schema.importQuestions.batchId, batchId))
      .orderBy(asc(schema.importQuestions.rowIndex));

    const excludedIds = new Set(
      staged.filter((row) => row.status === 'excluded').map((row) => row.id),
    );

    // 重組成匯入格式再驗證，確保修正後走的是同一套規則。
    const rebuilt = {
      schemaVersion: '1.0.0',
      subject: { name: 'placeholder' },
      questionGroup: { name: 'placeholder' },
      questions: staged
        .filter((row) => !excludedIds.has(row.id))
        .map((row) => ({
          externalId: row.externalId,
          questionNumber: row.questionNumber,
          type: row.type,
          stem: row.stem,
          options: (row.options as { key: string; text: string }[] | null) ?? [],
          correctAnswers:
            ((row.options as { key: string; isCorrect?: boolean }[] | null) ?? [])
              .filter((o) => o.isCorrect)
              .map((o) => o.key),
          explanation: row.explanation,
          sourcePage: row.sourcePage,
          sourceReference: row.sourceReference,
          reviewRequired: row.reviewRequired,
          reviewReason: row.reviewReason,
        })),
    };

    const context = await this.buildValidationContext(userId, batchId);
    const result = validateImportFile(rebuilt, context);

    const activeRows = staged.filter((row) => !excludedIds.has(row.id));

    await this.database.db.transaction(async (tx) => {
      await tx
        .delete(schema.importValidationIssues)
        .where(eq(schema.importValidationIssues.batchId, batchId));

      for (const [index, normalized] of result.rows.entries()) {
        const target = activeRows[index];
        if (!target) continue;

        await tx
          .update(schema.importQuestions)
          .set({
            status: normalized.hasError
              ? 'error'
              : normalized.issues.length > 0
                ? 'warning'
                : 'valid',
            updatedAt: new Date(),
          })
          .where(eq(schema.importQuestions.id, target.id));

        if (normalized.issues.length > 0) {
          await tx.insert(schema.importValidationIssues).values(
            normalized.issues.map((issue) => ({
              batchId,
              importQuestionId: target.id,
              level: issue.level,
              code: issue.code,
              fieldPath: issue.fieldPath ?? null,
              message: issue.message,
            })),
          );
        }
      }
    });

    return this.recountBatch(userId, batchId);
  }

  /**
   * 確認匯入：把暫存區寫入正式題庫。
   *
   * 這是整個流程中唯一會寫入 questions 的地方，且只接受
   * valid / warning / fixed 狀態的題目 —— error 與 excluded 一律略過。
   */
  async commit(
    userId: string,
    batchId: string,
    dto: CommitImportRequest,
  ): Promise<CommitImportResult> {
    const batch = await this.getBatch(userId, batchId);

    if (batch.status === 'committed') {
      throw new AppException(ERROR_CODES.IMPORT_BATCH_NOT_COMMITTABLE, '此批次已經匯入過了。');
    }
    if (batch.status === 'discarded') {
      throw new AppException(ERROR_CODES.IMPORT_BATCH_NOT_COMMITTABLE, '此批次已被丟棄。');
    }
    if (!batch.canCommit) {
      throw new AppException(
        ERROR_CODES.IMPORT_HAS_BLOCKING_ERRORS,
        '仍有題目存在阻斷性錯誤，請先修正或排除後再確認匯入。',
      );
    }

    await this.assertCommitTarget(userId, dto);

    const rawRows = await this.database.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, batchId))
      .limit(1);
    const raw = rawRows[0]!.rawPayload as Record<string, unknown>;

    const staged = await this.database.db
      .select()
      .from(schema.importQuestions)
      .where(
        and(
          eq(schema.importQuestions.batchId, batchId),
          inArray(schema.importQuestions.status, [...COMMITTABLE_STATUSES]),
        ),
      )
      .orderBy(asc(schema.importQuestions.rowIndex));

    if (staged.length === 0) {
      throw new AppException(
        ERROR_CODES.IMPORT_HAS_BLOCKING_ERRORS,
        '沒有任何可匯入的題目（全部有錯誤或已被排除）。',
      );
    }

    return this.commitInTransaction(userId, batch, raw, dto, staged);
  }

  /**
   * 實際寫入正式題庫。
   *
   * 包一層是為了把資料庫的唯一鍵違反轉成看得懂的錯誤：
   * 題號衝突在上傳階段無法預先檢查（那時目標題組還沒決定），
   * 因此一律由這裡的唯一索引把關——但未經處理的話會以 500 浮出，
   * 使用者只會看到「伺服器錯誤」而不知道是哪一題的題號撞了。
   */
  /**
   * 寫入章節筆記，回傳 noteKey → studyNoteId 的對照。
   *
   * 重新匯入同一份 PDF 時以 (題組, noteKey) 為準**更新**既有筆記，而不是新增一筆：
   * 同一個 key 在同一個題組裡就是同一段筆記，堆兩份只會讓檢索同時撈到新舊兩版。
   * 更新後 content_hash 跟著變，AI 快取的筆記指紋自然失效，解析才會重新產生。
   */
  private async commitNotes(
    tx: Database,
    userId: string,
    target: { subjectId: string; chapterId: string | null; groupId: string },
    batchId: string,
    raw: Record<string, unknown>,
  ): Promise<Map<string, string>> {
    // 走與驗證階段完全相同的那支函式，避免「驗證通過的東西」與
    // 「實際寫進去的東西」是兩套解析結果。
    const notes = validateImportFile(raw, {
      existingExternalIds: new Set<string>(),
      existingQuestionNumbers: new Set<number>(),
      maxQuestions: this.env.IMPORT_MAX_QUESTIONS,
    }).notes;

    const idByKey = new Map<string, string>();
    if (notes.length === 0) return idByKey;

    for (const note of notes) {
      const inserted = await tx
        .insert(schema.studyNotes)
        .values({
          userId,
          subjectId: target.subjectId,
          chapterId: target.chapterId,
          questionGroupId: target.groupId,
          importBatchId: batchId,
          noteKey: note.noteKey,
          title: note.title,
          content: note.content,
          sourcePage: note.sourcePage,
          keywords: note.keywords,
          contentHash: computeNoteContentHash(note.content),
        })
        .onConflictDoUpdate({
          target: [schema.studyNotes.questionGroupId, schema.studyNotes.noteKey],
          targetWhere: sql`deleted_at is null`,
          set: {
            title: note.title,
            content: note.content,
            sourcePage: note.sourcePage,
            keywords: note.keywords,
            contentHash: computeNoteContentHash(note.content),
            importBatchId: batchId,
            updatedAt: new Date(),
          },
        })
        .returning({ id: schema.studyNotes.id });

      idByKey.set(note.noteKey, inserted[0]!.id);
    }

    this.logger.log(`匯入批次 ${batchId} 寫入 ${notes.length} 段章節筆記`);
    return idByKey;
  }

  private async commitInTransaction(
    userId: string,
    batch: ImportBatchResponse,
    raw: Record<string, unknown>,
    dto: CommitImportRequest,
    staged: (typeof schema.importQuestions.$inferSelect)[],
  ): Promise<CommitImportResult> {
    try {
      return await this.runCommit(userId, batch, raw, dto, staged);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppException(
          ERROR_CODES.CONFLICT,
          '目標題組中已有相同題號的題目。請改匯入到新的題組，或先調整題號。',
        );
      }
      throw error;
    }
  }

  private async runCommit(
    userId: string,
    batch: ImportBatchResponse,
    raw: Record<string, unknown>,
    dto: CommitImportRequest,
    staged: (typeof schema.importQuestions.$inferSelect)[],
  ): Promise<CommitImportResult> {
    return this.database.db.transaction(async (tx) => {
      const target = await this.resolveTarget(tx, userId, raw, dto);

      // 筆記必須先寫入：題目的關聯要指向它們的 id。
      const noteIdByKey = await this.commitNotes(tx, userId, target, batch.id, raw);
      const rawQuestions = Array.isArray(raw.questions) ? raw.questions : [];

      let committed = 0;

      for (const row of staged) {
        const options = (row.options as { key: string; text: string; isCorrect: boolean }[]) ?? [];
        const contentHash = computeQuestionContentHash({
          type: row.type ?? 'single_choice',
          stem: row.stem ?? '',
          options,
        });

        const inserted = await tx
          .insert(schema.questions)
          .values({
            userId,
            questionGroupId: target.groupId,
            subjectId: target.subjectId,
            chapterId: target.chapterId,
            externalId: row.externalId,
            questionNumber: row.questionNumber!,
            type: row.type as 'single_choice' | 'multiple_choice',
            stem: row.stem!,
            // 沒有解析就是 null。系統絕不自動編造（規格 §5）。
            explanation: row.explanation,
            sourcePage: row.sourcePage,
            sourceReference: row.sourceReference,
            reviewRequired: row.reviewRequired,
            reviewReason: row.reviewReason,
            contentHash,
          })
          .returning({ id: schema.questions.id });

        const questionId = inserted[0]!.id;

        await tx.insert(schema.questionOptions).values(
          options.map((option, index) => ({
            questionId,
            key: option.key,
            text: option.text,
            isCorrect: option.isCorrect,
            sortOrder: index,
          })),
        );

        await tx.insert(schema.questionVersions).values({
          questionId,
          version: 1,
          contentHash,
          snapshot: {
            type: row.type,
            stem: row.stem,
            options,
            explanation: row.explanation,
            questionNumber: row.questionNumber,
          },
          changeReason: `由匯入批次 ${batch.id} 建立`,
          createdBy: userId,
        });

        // 題目與筆記的明確關聯。
        //
        // relatedNoteIds 不在預覽頁可編輯的欄位裡，因此以原始檔案為準，
        // 依 rowIndex 對回去。對不上的 key 在驗證階段已經是 error，
        // 這裡再過濾一次是為了「就算漏了也不會插出壞掉的關聯」。
        const rawRow = rawQuestions[row.rowIndex] as Record<string, unknown> | undefined;
        const linkedNoteIds = (
          Array.isArray(rawRow?.relatedNoteIds) ? rawRow.relatedNoteIds : []
        )
          .map((key) => (typeof key === 'string' ? noteIdByKey.get(key.trim()) : undefined))
          .filter((id): id is string => id !== undefined);

        if (linkedNoteIds.length > 0) {
          await tx
            .insert(schema.questionNoteLinks)
            .values([...new Set(linkedNoteIds)].map((studyNoteId) => ({ questionId, studyNoteId })))
            .onConflictDoNothing();
        }

        await tx
          .update(schema.importQuestions)
          .set({ status: 'committed', resultingQuestionId: questionId, updatedAt: new Date() })
          .where(eq(schema.importQuestions.id, row.id));

        committed += 1;
      }

      await tx
        .update(schema.importBatches)
        .set({
          status: 'committed',
          committedCount: committed,
          committedAt: new Date(),
          targetSubjectId: target.subjectId,
          targetChapterId: target.chapterId,
          targetGroupId: target.groupId,
          updatedAt: new Date(),
        })
        .where(eq(schema.importBatches.id, batch.id));

      return {
        batchId: batch.id,
        committedCount: committed,
        skippedCount: batch.totalCount - committed,
        subjectId: target.subjectId,
        chapterId: target.chapterId,
        questionGroupId: target.groupId,
      };
    });
  }

  async discard(userId: string, batchId: string): Promise<void> {
    const batch = await this.getBatch(userId, batchId);
    if (batch.status === 'committed') {
      throw new AppException(
        ERROR_CODES.IMPORT_BATCH_NOT_COMMITTABLE,
        '已匯入的批次不可丟棄（資料已進入正式題庫）。',
      );
    }
    await this.database.db
      .update(schema.importBatches)
      .set({ status: 'discarded', updatedAt: new Date() })
      .where(eq(schema.importBatches.id, batchId));
  }

  // ------------------------------------------------------------- helpers

  private async persistRows(
    tx: Database,
    batchId: string,
    rows: NormalizedImportQuestion[],
  ): Promise<void> {
    for (const row of rows) {
      const inserted = await tx
        .insert(schema.importQuestions)
        .values({
          batchId,
          rowIndex: row.rowIndex,
          externalId: row.externalId,
          questionNumber: row.questionNumber,
          type: row.type,
          stem: row.stem,
          options: row.options,
          correctAnswers: row.options?.filter((o) => o.isCorrect).map((o) => o.key) ?? null,
          explanation: row.explanation,
          sourcePage: row.sourcePage,
          sourceReference: row.sourceReference,
          reviewRequired: row.reviewRequired,
          reviewReason: row.reviewReason,
          status: row.hasError ? 'error' : row.issues.length > 0 ? 'warning' : 'valid',
        })
        .returning({ id: schema.importQuestions.id });

      if (row.issues.length > 0) {
        await tx.insert(schema.importValidationIssues).values(
          row.issues.map((issue) => ({
            batchId,
            importQuestionId: inserted[0]!.id,
            level: issue.level,
            code: issue.code,
            fieldPath: issue.fieldPath ?? null,
            message: issue.message,
          })),
        );
      }
    }
  }

  private async buildValidationContext(
    userId: string,
    excludeBatchId: string | null,
  ): Promise<ImportValidationContext> {
    const existing = await this.database.db
      .select({ externalId: schema.questions.externalId })
      .from(schema.questions)
      .where(and(eq(schema.questions.userId, userId), isNull(schema.questions.deletedAt)));

    void excludeBatchId;

    return {
      existingExternalIds: new Set(
        existing.map((row) => row.externalId).filter((v): v is string => Boolean(v)),
      ),
      // 題號衝突只在確定目標題組後才有意義；上傳階段目標題組尚未建立，
      // 因此此處不檢查，改由 commit 時的資料庫唯一索引把關。
      existingQuestionNumbers: new Set<number>(),
      maxQuestions: this.env.IMPORT_MAX_QUESTIONS,
    };
  }

  private async assertBatchMutable(userId: string, batchId: string): Promise<void> {
    const batch = await this.getBatch(userId, batchId);
    if (batch.status === 'committed' || batch.status === 'discarded') {
      throw new AppException(
        ERROR_CODES.IMPORT_BATCH_NOT_COMMITTABLE,
        '此批次已結束，無法再修改。',
      );
    }
  }

  /** 重新計算批次統計並回傳最新狀態。 */
  private async recountBatch(userId: string, batchId: string): Promise<ImportBatchResponse> {
    const rows = await this.database.db
      .select({ status: schema.importQuestions.status, reviewRequired: schema.importQuestions.reviewRequired })
      .from(schema.importQuestions)
      .where(eq(schema.importQuestions.batchId, batchId));

    const errorCount = rows.filter((r) => r.status === 'error').length;
    const warningCount = rows.filter((r) => r.status === 'warning').length;
    const validCount = rows.filter((r) => r.status === 'valid' || r.status === 'warning').length;

    await this.database.db
      .update(schema.importBatches)
      .set({
        errorCount,
        warningCount,
        validCount,
        reviewRequiredCount: rows.filter((r) => r.reviewRequired).length,
        status: errorCount > 0 ? 'partially_valid' : 'validated',
        updatedAt: new Date(),
      })
      .where(eq(schema.importBatches.id, batchId));

    return this.getBatch(userId, batchId);
  }

  /** 決定匯入目標：優先使用呼叫端指定的 ID，否則依檔案內容建立或沿用。 */
  private async resolveTarget(
    tx: Database,
    userId: string,
    raw: Record<string, unknown>,
    dto: CommitImportRequest,
  ): Promise<{ subjectId: string; chapterId: string | null; groupId: string }> {
    if (dto.targetGroupId) {
      const rows = await tx
        .select({
          id: schema.questionGroups.id,
          subjectId: schema.questionGroups.subjectId,
          chapterId: schema.questionGroups.chapterId,
        })
        .from(schema.questionGroups)
        .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questionGroups.subjectId))
        .where(
          and(
            eq(schema.questionGroups.id, dto.targetGroupId),
            eq(schema.subjects.userId, userId),
            isNull(schema.questionGroups.deletedAt),
          ),
        )
        .limit(1);

      const group = rows[0];
      if (!group) {
        throw new AppException(ERROR_CODES.QUESTION_GROUP_NOT_FOUND, '找不到指定的目標題組。');
      }
      return { subjectId: group.subjectId, chapterId: group.chapterId, groupId: group.id };
    }

    const subjectName = this.nameOf(raw.subject) ?? '未命名科目';
    const chapterName = this.nameOf(raw.chapter);
    const groupName = this.nameOf(raw.questionGroup) ?? '未命名題組';
    const groupMeta = (raw.questionGroup ?? {}) as Record<string, unknown>;

    const subjectId =
      dto.targetSubjectId ?? (await this.findOrCreateSubject(tx, userId, subjectName));

    // 指定的科目必須是自己的，否則等於可以把題目匯進別人的科目。
    if (dto.targetSubjectId) {
      const owned = await tx
        .select({ id: schema.subjects.id })
        .from(schema.subjects)
        .where(and(eq(schema.subjects.id, subjectId), eq(schema.subjects.userId, userId)))
        .limit(1);
      if (owned.length === 0) {
        throw new AppException(ERROR_CODES.NOT_FOUND, '找不到指定的目標科目。');
      }
    }

    let chapterId = dto.targetChapterId ?? null;

    /*
     * 指定的章節必須屬於指定的科目。
     *
     * 不擋的話只會撞到 question_groups 的複合外鍵，
     * 使用者拿到的是一個看不懂的 500，而不是「這個章節不屬於這個科目」。
     */
    if (chapterId) {
      const rows = await tx
        .select({ id: schema.chapters.id })
        .from(schema.chapters)
        .innerJoin(schema.subjects, eq(schema.subjects.id, schema.chapters.subjectId))
        .where(
          and(
            eq(schema.chapters.id, chapterId),
            eq(schema.chapters.subjectId, subjectId),
            eq(schema.subjects.userId, userId),
          ),
        )
        .limit(1);
      if (rows.length === 0) {
        throw new AppException(
          ERROR_CODES.CHAPTER_SUBJECT_MISMATCH,
          '指定的章節不屬於指定的科目。',
        );
      }
    }

    if (!chapterId && chapterName) {
      chapterId = await this.findOrCreateChapter(tx, subjectId, chapterName);
    }

    const created = await tx
      .insert(schema.questionGroups)
      .values({
        subjectId,
        chapterId,
        name: groupName,
        source: typeof groupMeta.source === 'string' ? groupMeta.source : null,
        year: typeof groupMeta.year === 'number' ? groupMeta.year : null,
        notes: typeof groupMeta.notes === 'string' ? groupMeta.notes : null,
        description: typeof groupMeta.description === 'string' ? groupMeta.description : null,
      })
      .returning({ id: schema.questionGroups.id });

    return { subjectId, chapterId, groupId: created[0]!.id };
  }

  /**
   * 檢查 commit 指定的匯入目標。
   *
   * 這兩個值直接來自請求主體，之前完全沒有驗證就拿去建題組：
   *   - 沒有檢查科目是否屬於自己（單一使用者情境下影響有限，但這是不該省的檢查）；
   *   - 沒有檢查章節是否屬於該科目。後者一般使用者就碰得到——
   *     真正擋下它的是 question_groups 的複合外鍵，但那會以未處理的資料庫錯誤浮出成 500，
   *     而不是一個看得懂的 409。
   */
  private async assertCommitTarget(userId: string, dto: CommitImportRequest): Promise<void> {
    if (!dto.targetSubjectId && !dto.targetChapterId) return;

    if (dto.targetSubjectId) {
      const rows = await this.database.db
        .select({ id: schema.subjects.id })
        .from(schema.subjects)
        .where(
          and(
            eq(schema.subjects.id, dto.targetSubjectId),
            eq(schema.subjects.userId, userId),
            isNull(schema.subjects.deletedAt),
          ),
        )
        .limit(1);
      if (rows.length === 0) {
        throw new AppException(ERROR_CODES.SUBJECT_NOT_FOUND, '指定的匯入科目不存在。');
      }
    }

    if (dto.targetChapterId) {
      const rows = await this.database.db
        .select({ subjectId: schema.chapters.subjectId })
        .from(schema.chapters)
        .innerJoin(schema.subjects, eq(schema.subjects.id, schema.chapters.subjectId))
        .where(
          and(
            eq(schema.chapters.id, dto.targetChapterId),
            eq(schema.subjects.userId, userId),
            isNull(schema.chapters.deletedAt),
          ),
        )
        .limit(1);

      const chapter = rows[0];
      if (!chapter) {
        throw new AppException(ERROR_CODES.CHAPTER_NOT_FOUND, '指定的匯入章節不存在。');
      }
      // 沒指定科目時，章節本身就決定了科目，不可能不一致。
      if (dto.targetSubjectId && chapter.subjectId !== dto.targetSubjectId) {
        throw new AppException(
          ERROR_CODES.CHAPTER_SUBJECT_MISMATCH,
          '指定的章節不屬於指定的科目。',
        );
      }
    }
  }

  private nameOf(value: unknown): string | null {
    if (typeof value !== 'object' || value === null) return null;
    const name = (value as Record<string, unknown>).name;
    return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
  }

  private async findOrCreateSubject(tx: Database, userId: string, name: string): Promise<string> {
    const existing = await tx
      .select({ id: schema.subjects.id })
      .from(schema.subjects)
      .where(
        and(
          eq(schema.subjects.userId, userId),
          eq(schema.subjects.name, name),
          isNull(schema.subjects.deletedAt),
        ),
      )
      .limit(1);

    if (existing[0]) return existing[0].id;

    const created = await tx
      .insert(schema.subjects)
      .values({ userId, name })
      .returning({ id: schema.subjects.id });
    return created[0]!.id;
  }

  private async findOrCreateChapter(
    tx: Database,
    subjectId: string,
    name: string,
  ): Promise<string> {
    const existing = await tx
      .select({ id: schema.chapters.id })
      .from(schema.chapters)
      .where(
        and(
          eq(schema.chapters.subjectId, subjectId),
          eq(schema.chapters.name, name),
          isNull(schema.chapters.deletedAt),
        ),
      )
      .limit(1);

    if (existing[0]) return existing[0].id;

    const created = await tx
      .insert(schema.chapters)
      .values({ subjectId, name })
      .returning({ id: schema.chapters.id });
    return created[0]!.id;
  }
}

/** PostgreSQL 23505 = unique_violation。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
  );
}
