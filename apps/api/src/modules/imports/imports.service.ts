import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { computeNoteContentHash, computeQuestionContentHash } from '@repo/contracts/server';
import {
  ERROR_CODES,
  validateImportFile,
  validateImportFiles,
  type CommitImportRequest,
  type CommitImportResult,
  type Env,
  type FixImportQuestionRequest,
  type ImportBatchResponse,
  type ImportGroupResponse,
  type ImportFileInput,
  type ImportQuestionResponse,
  type ImportValidationContext,
  type NormalizedImportGroup,
  type NormalizedImportNote,
  type NormalizedImportQuestion,
} from '@repo/contracts';
import { schema, type Database, type DatabaseHandle } from '@repo/db';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { ENV } from '../../config/env.config';
import { DATABASE } from '../../infra/infra.module';

/**
 * 把保存的原始內容還原成檔案清單。
 *
 * 單檔上傳直接存檔案本身；多檔上傳存成 `{ files: [{ filename, content }] }`。
 * 兩種形狀在這裡收斂，呼叫端只看得到一種。
 */
function parseRawPayload(raw: Record<string, unknown>): ImportFileInput[] {
  const files = raw.files;
  if (Array.isArray(files)) {
    return files.map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return {
        filename: typeof item.filename === 'string' ? item.filename : null,
        raw: item.content,
      };
    });
  }
  return [{ filename: null, raw }];
}

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
    files: { originalname: string; size: number; buffer: Buffer }[],
  ): Promise<ImportBatchResponse> {
    if (files.length === 0) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, '請至少選擇一個檔案。');
    }

    const inputs = files.map((file) => {
      try {
        return { filename: file.originalname, raw: JSON.parse(file.buffer.toString('utf8')) };
      } catch (error) {
        throw new AppException(
          ERROR_CODES.IMPORT_FILE_INVALID_JSON,
          `${file.originalname} 不是合法的 JSON：${error instanceof Error ? error.message : '解析失敗'}`,
        );
      }
    });

    const context = await this.buildValidationContext(userId);
    const result = validateImportFiles(inputs, context);

    const first = inputs[0]!.raw as Record<string, unknown>;
    const schemaVersion = typeof first.schemaVersion === 'string' ? first.schemaVersion : null;

    // 多檔上傳時把整批的原始內容一起保存，事後才追溯得出每一題來自哪一份。
    const rawPayload =
      inputs.length === 1
        ? (inputs[0]!.raw as object)
        : { files: inputs.map((i) => ({ filename: i.filename, content: i.raw })) };

    const batchId = await this.database.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.importBatches)
        .values({
          userId,
          filename:
            files.length === 1
              ? files[0]!.originalname
              : `${files[0]!.originalname} 等 ${files.length} 個檔案`,
          fileSize: files.reduce((sum, f) => sum + f.size, 0),
          fileHash: createHash('sha256')
            .update(Buffer.concat(files.map((f) => f.buffer)))
            .digest('hex'),
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
          rawPayload,
          errorSummary: { fileIssues: result.fileIssues },
          validatedAt: new Date(),
        })
        .returning({ id: schema.importBatches.id });

      const id = inserted[0]!.id;
      await this.persistGroupsAndRows(tx, id, result.groups);
      return id;
    });

    return this.getBatch(userId, batchId);
  }

  /**
   * 寫入題組與其題目。
   *
   * 題組必須先插入才拿得到 id 供題目回指——這也是為什麼題目不能像以前那樣
   * 只用一個扁平的迴圈處理。
   */
  private async persistGroupsAndRows(
    tx: Database,
    batchId: string,
    groups: NormalizedImportGroup[],
  ): Promise<void> {
    for (const group of groups) {
      const insertedGroup = await tx
        .insert(schema.importQuestionGroups)
        .values({
          batchId,
          groupIndex: group.groupIndex,
          sourceFilename: group.sourceFilename,
          chapterName: group.chapterName,
          groupName: group.groupName,
          source: group.source,
          year: group.year,
          notes: group.groupNotes,
          noteCount: group.studyNotes.length,
          totalCount: group.rows.length,
          validCount: group.validCount,
          errorCount: group.errorCount,
          warningCount: group.warningCount,
        })
        .returning({ id: schema.importQuestionGroups.id });

      await this.persistRows(tx, batchId, insertedGroup[0]!.id, group.rows);
    }
  }

  /**
   * 讀取批次中的題組，並逐組算出可否寫入。
   *
   * 題組出現之前建立的舊批次沒有這些列，回傳空陣列即可——
   * 那些批次全部已是終端狀態，介面沿用原本的平鋪顯示。
   */
  private async loadGroups(batchId: string): Promise<ImportGroupResponse[]> {
    const rows = await this.database.db
      .select({
        group: schema.importQuestionGroups,
        blocking: sql<number>`(
          select count(*)::int from import_questions q
          where q.import_group_id = import_question_groups.id and q.status = 'error')`,
        committable: sql<number>`(
          select count(*)::int from import_questions q
          where q.import_group_id = import_question_groups.id
            and q.status in ('valid', 'warning', 'fixed'))`,
      })
      .from(schema.importQuestionGroups)
      .where(eq(schema.importQuestionGroups.batchId, batchId))
      .orderBy(asc(schema.importQuestionGroups.groupIndex));

    return rows.map(({ group, blocking, committable }) => ({
      id: group.id,
      groupIndex: group.groupIndex,
      sourceFilename: group.sourceFilename,
      chapterName: group.chapterName,
      groupName: group.groupName,
      totalCount: group.totalCount,
      validCount: group.validCount,
      errorCount: blocking,
      warningCount: group.warningCount,
      committedCount: group.committedCount,
      noteCount: group.noteCount,
      // 已經寫入過的題組不會再寫第二次。
      canCommit: group.resultingGroupId === null && blocking === 0 && committable > 0,
      resultingGroupId: group.resultingGroupId,
    }));
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

    const groups = await this.loadGroups(batchId);
    const fileLevelOk = fileIssues.every((i) => i.level !== 'error');
    const batchOpen = batch.status !== 'committed' && batch.status !== 'discarded';

    /*
     * 逐題組判斷可否寫入——使用者裁決「沒錯的先匯、有錯的擋下」。
     *
     * 批次層的 canCommit 因此改成「**有沒有任何一組可以寫**」，
     * 而不是「全部都沒問題」。舊語意會讓一整批 200 題因為某一組的一題 OCR
     * 有問題就全部卡住。沒有題組的舊批次沿用原本的判準。
     */
    const canCommit =
      batchOpen &&
      fileLevelOk &&
      batch.totalCount > 0 &&
      (groups.length > 0 ? groups.some((g) => g.canCommit) : blockingCount === 0);

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
      groups,
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
      importGroupId: row.importGroupId,
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

    /*
     * 已排除與**已匯入**的列都不再參與驗證。
     *
     * committed 的列早就寫進 questions 了，再驗一次一定會拿它自己的 externalId
     * 去撞資料庫裡的自己，得到 DUPLICATE_EXTERNAL_ID_IN_DB——批次於是永遠有
     * 阻斷性錯誤，剩下那些修好的題組再也匯不進來。逐題組匯入之前不會踩到，
     * 因為那時一個批次要嘛全進要嘛全不進。
     */
    const skippedIds = new Set(
      staged
        .filter((row) => row.status === 'excluded' || row.status === 'committed')
        .map((row) => row.id),
    );

    /*
     * 重組成匯入格式再驗證，確保修正後走的是同一套規則。
     *
     * 一定要重建成**分組**的 1.2.0 結構：題號只在題組內唯一，
     * 把多個題組的題目平鋪回單一題組，第一章與第二章的第 1 題
     * 就會被誤判成重複題號。
     */
    const activeStaged = staged.filter((row) => !skippedIds.has(row.id));
    const byGroup = new Map<string, typeof activeStaged>();
    for (const row of activeStaged) {
      const key = row.importGroupId ?? 'legacy';
      const list = byGroup.get(key) ?? [];
      list.push(row);
      byGroup.set(key, list);
    }

    const toRawQuestion = (row: (typeof activeStaged)[number]) => ({
      externalId: row.externalId,
      questionNumber: row.questionNumber,
      type: row.type,
      stem: row.stem,
      options: (row.options as { key: string; text: string }[] | null) ?? [],
      correctAnswers: ((row.options as { key: string; isCorrect?: boolean }[] | null) ?? [])
        .filter((o) => o.isCorrect)
        .map((o) => o.key),
      explanation: row.explanation,
      sourcePage: row.sourcePage,
      sourceReference: row.sourceReference,
      reviewRequired: row.reviewRequired,
      reviewReason: row.reviewReason,
    });

    const rebuilt = {
      schemaVersion: '1.2.0',
      subject: { name: 'placeholder' },
      questionGroups: [...byGroup.values()].map((rows, index) => ({
        name: `placeholder-${index}`,
        questions: rows.map(toRawQuestion),
      })),
    };

    const context = await this.buildValidationContext(userId);
    const result = validateImportFile(rebuilt, context);

    // 驗證結果的順序 = 題組順序 × 組內順序，與這裡攤平的順序一致。
    const activeRows = [...byGroup.values()].flat();

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
    notes: NormalizedImportNote[],
  ): Promise<Map<string, string>> {
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

    this.logger.log(`匯入批次 ${batchId} 的題組寫入 ${notes.length} 段章節筆記`);
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
    /*
     * 重新跑一次驗證取得題組結構。
     *
     * 需要的是 `relatedNoteIds` 與各題組的筆記——它們只存在原始檔案裡。
     * 走與上傳時**完全相同**的那支函式，才不會出現「驗證通過的東西」與
     * 「實際寫進去的東西」是兩套解析結果。
     */
    const context = await this.buildValidationContext(userId);
    const validated = validateImportFiles(parseRawPayload(raw), context);
    const noteKeysByRowIndex = new Map(
      validated.rows.map((row) => [row.rowIndex, row.relatedNoteIds]),
    );

    const dbGroups = await this.database.db
      .select()
      .from(schema.importQuestionGroups)
      .where(eq(schema.importQuestionGroups.batchId, batch.id))
      .orderBy(asc(schema.importQuestionGroups.groupIndex));

    /*
     * 指定既有題組時整批都併進那一組（沿用既有的「補匯到同一題組」行為）。
     *
     * 只有單一題組的批次能這樣做：多個題組併成一組，等於把不同章節的題目
     * 混在一起，而且各組的章節資訊會被默默丟掉。
     */
    const pendingGroups = dbGroups.filter((g) => g.resultingGroupId === null);
    if (dto.targetGroupId && pendingGroups.length > 1) {
      throw new AppException(
        ERROR_CODES.VALIDATION_FAILED,
        '這批有多個題組，無法全部併入同一個既有題組。請改為指定科目與章節，或分批匯入。',
      );
    }

    return this.database.db.transaction(async (tx) => {
      // 指定既有題組時，科目與章節以那一組為準——它已經在庫裡了，不該被覆寫。
      const existingTarget = dto.targetGroupId
        ? await this.resolveExistingGroup(tx, userId, dto.targetGroupId)
        : null;
      const subjectId = existingTarget?.subjectId ?? (await this.resolveSubject(tx, userId, raw, dto));

      const results: CommitImportResult['groups'] = [];
      let committedTotal = 0;
      let firstChapterId: string | null = null;
      let firstGroupId: string | null = null;

      for (const dbGroup of dbGroups) {
        const rows = staged.filter((row) => row.importGroupId === dbGroup.id);
        const alreadyCommitted = dbGroup.resultingGroupId !== null;
        const hasBlocking = batch.groups.find((g) => g.id === dbGroup.id)?.canCommit === false;

        // 有阻斷性錯誤或已經寫過的題組整組跳過，其餘照常寫入。
        if (alreadyCommitted || hasBlocking || rows.length === 0) {
          results.push({
            groupIndex: dbGroup.groupIndex,
            groupName: dbGroup.groupName,
            chapterName: dbGroup.chapterName,
            // 這一次寫了幾題——兩種情況都是 0。回報累計值會讓呼叫端
            // 無法分辨「剛剛寫了 2 題」與「先前就有 2 題」。
            committedCount: 0,
            skipped: !alreadyCommitted,
            alreadyCommitted,
            questionGroupId: dbGroup.resultingGroupId,
          });
          continue;
        }

        // 章節逐題組解析：同一批可以橫跨多個章節，這正是這個功能的重點。
        const chapterId =
          existingTarget?.chapterId ??
          (await this.resolveChapterForGroup(tx, userId, subjectId, dbGroup.chapterName, dto));

        let questionGroupId = existingTarget?.id ?? null;
        if (questionGroupId === null) {
          const createdGroup = await tx
            .insert(schema.questionGroups)
            .values({
              subjectId,
              chapterId,
              name: dbGroup.groupName,
              source: dbGroup.source,
              year: dbGroup.year,
              notes: dbGroup.notes,
            })
            .returning({ id: schema.questionGroups.id });
          questionGroupId = createdGroup[0]!.id;
        }

        const validatedGroup = validated.groups.find((g) => g.groupIndex === dbGroup.groupIndex);
        const noteIdByKey = await this.commitNotes(
          tx,
          userId,
          { subjectId, chapterId, groupId: questionGroupId },
          batch.id,
          validatedGroup?.studyNotes ?? [],
        );

        let committed = 0;
        for (const row of rows) {
          const options =
            (row.options as { key: string; text: string; isCorrect: boolean }[]) ?? [];
          const contentHash = computeQuestionContentHash({
            type: row.type ?? 'single_choice',
            stem: row.stem ?? '',
            options,
          });

          const inserted = await tx
            .insert(schema.questions)
            .values({
              userId,
              questionGroupId,
              subjectId,
              chapterId,
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

          /*
           * 題目與筆記的明確關聯。
           *
           * relatedNoteIds 以**驗證結果**為準而不是直接讀 raw.questions[rowIndex]：
           * 多題組時 rowIndex 是跨題組的流水號，拿它去索引單一題組的 questions
           * 陣列會對到別組的題目。
           */
          const linkedNoteIds = (noteKeysByRowIndex.get(row.rowIndex) ?? [])
            .map((key) => noteIdByKey.get(key))
            .filter((id): id is string => id !== undefined);

          if (linkedNoteIds.length > 0) {
            await tx
              .insert(schema.questionNoteLinks)
              .values(
                [...new Set(linkedNoteIds)].map((studyNoteId) => ({ questionId, studyNoteId })),
              )
              .onConflictDoNothing();
          }

          await tx
            .update(schema.importQuestions)
            .set({ status: 'committed', resultingQuestionId: questionId, updatedAt: new Date() })
            .where(eq(schema.importQuestions.id, row.id));

          committed += 1;
        }

        await tx
          .update(schema.importQuestionGroups)
          .set({ committedCount: committed, resultingGroupId: questionGroupId, updatedAt: new Date() })
          .where(eq(schema.importQuestionGroups.id, dbGroup.id));

        committedTotal += committed;
        firstChapterId ??= chapterId;
        firstGroupId ??= questionGroupId;

        results.push({
          groupIndex: dbGroup.groupIndex,
          groupName: dbGroup.groupName,
          chapterName: dbGroup.chapterName,
          committedCount: committed,
          skipped: false,
          alreadyCommitted: false,
          questionGroupId,
        });
      }

      if (committedTotal === 0) {
        throw new AppException(
          ERROR_CODES.IMPORT_HAS_BLOCKING_ERRORS,
          '沒有任何可匯入的題目（全部有錯誤或已被排除）。',
        );
      }

      /*
       * 還有題組沒寫入時**不能**把批次標成 committed。
       *
       * 標成 committed 會讓使用者再也無法在修正錯誤後把剩下的題組匯進來——
       * 那正是「沒錯的先匯」這個決定要換到的東西。
       */
      const allDone = results.every((r) => !r.skipped);
      await tx
        .update(schema.importBatches)
        .set({
          status: allDone ? 'committed' : 'partially_valid',
          committedCount: (batch.committedCount ?? 0) + committedTotal,
          committedAt: allDone ? new Date() : null,
          targetSubjectId: subjectId,
          targetChapterId: firstChapterId,
          targetGroupId: firstGroupId,
          updatedAt: new Date(),
        })
        .where(eq(schema.importBatches.id, batch.id));

      return {
        batchId: batch.id,
        committedCount: committedTotal,
        skippedCount: batch.totalCount - committedTotal,
        subjectId,
        chapterId: firstChapterId,
        questionGroupId: firstGroupId!,
        groups: results,
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
    importGroupId: string,
    rows: NormalizedImportQuestion[],
  ): Promise<void> {
    for (const row of rows) {
      const inserted = await tx
        .insert(schema.importQuestions)
        .values({
          batchId,
          importGroupId,
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

  private async buildValidationContext(userId: string): Promise<ImportValidationContext> {
    const existing = await this.database.db
      .select({ externalId: schema.questions.externalId })
      .from(schema.questions)
      .where(and(eq(schema.questions.userId, userId), isNull(schema.questions.deletedAt)));

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
  /**
   * 取出使用者指定的既有題組。
   *
   * 科目與章節都跟著它走：題組已經在庫裡，匯入不該把它搬家。
   */
  private async resolveExistingGroup(
    tx: Database,
    userId: string,
    groupId: string,
  ): Promise<{ id: string; subjectId: string; chapterId: string | null }> {
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
          eq(schema.questionGroups.id, groupId),
          eq(schema.subjects.userId, userId),
          isNull(schema.questionGroups.deletedAt),
        ),
      )
      .limit(1);

    const group = rows[0];
    if (!group) {
      throw new AppException(ERROR_CODES.NOT_FOUND, '找不到指定的目標題組。');
    }
    return group;
  }

  /**
   * 決定整批要匯入哪個科目。
   *
   * 一個批次只有一個科目——多檔上傳時驗證階段已經擋掉科目不一致的情況。
   * 章節則逐題組決定，因為「同一科目的不同章節」正是這個功能存在的理由。
   */
  private async resolveSubject(
    tx: Database,
    userId: string,
    raw: Record<string, unknown>,
    dto: CommitImportRequest,
  ): Promise<string> {
    if (dto.targetSubjectId) {
      const owned = await tx
        .select({ id: schema.subjects.id })
        .from(schema.subjects)
        .where(
          and(eq(schema.subjects.id, dto.targetSubjectId), eq(schema.subjects.userId, userId)),
        )
        .limit(1);
      if (owned.length === 0) {
        throw new AppException(ERROR_CODES.NOT_FOUND, '找不到指定的目標科目。');
      }
      return dto.targetSubjectId;
    }

    const first = parseRawPayload(raw)[0]?.raw as Record<string, unknown> | undefined;
    const subject = (first?.subject ?? {}) as Record<string, unknown>;
    const name = typeof subject.name === 'string' && subject.name.trim() !== ''
      ? subject.name.trim()
      : '未命名科目';
    return this.findOrCreateSubject(tx, userId, name);
  }

  /**
   * 決定某個題組要落在哪個章節。
   *
   * 呼叫端明確指定章節時整批共用那一個；否則依題組自己的章節名稱建立或沿用。
   * 指定的章節必須屬於指定的科目——不擋的話只會撞到 question_groups 的
   * 複合外鍵，使用者拿到的是看不懂的 500。
   */
  private async resolveChapterForGroup(
    tx: Database,
    userId: string,
    subjectId: string,
    chapterName: string | null,
    dto: CommitImportRequest,
  ): Promise<string | null> {
    if (dto.targetChapterId) {
      const rows = await tx
        .select({ id: schema.chapters.id })
        .from(schema.chapters)
        .innerJoin(schema.subjects, eq(schema.subjects.id, schema.chapters.subjectId))
        .where(
          and(
            eq(schema.chapters.id, dto.targetChapterId),
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
      return dto.targetChapterId;
    }

    if (!chapterName) return null;
    return this.findOrCreateChapter(tx, subjectId, chapterName);
  }

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
