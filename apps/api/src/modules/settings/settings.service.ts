import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  quizDefaultsSchema,
  QUIZ_DEFAULTS_KEY,
  SECRET_ENV_KEYS,
  type Env,
  type MaintenanceCleanupRequest,
  type MaintenanceCleanupResult,
  type MaintenancePreview,
  type QuizDefaults,
  type SettingsResponse,
  type UpdateSettingsRequest,
} from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';

import { ENV } from '../../config/env.config';
import { DATABASE } from '../../infra/infra.module';
import { MistakeRecordsService } from '../quiz/mistake-records.service';

/**
 * 系統設定與維護作業。
 *
 * 設定值存在 `app_settings`（key/value 的 jsonb 表），不是環境變數：
 * 環境變數改動要重啟，而且會被下次 `bootstrap-env` 的預設值蓋回去。
 *
 * **機密永遠不會出現在回應裡**，只給「有沒有設定」的布林值。
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(ENV) private readonly env: Env,
    private readonly mistakeRecords: MistakeRecordsService,
  ) {}

  async get(): Promise<SettingsResponse> {
    return {
      quizDefaults: await this.quizDefaults(),
      system: {
        aiProvider: this.env.AI_PROVIDER,
        searchProvider: this.env.SEARCH_PROVIDER,
        model: this.env.NVIDIA_MODEL,
        reasoningEffort: {
          plan: this.env.AI_REASONING_EFFORT_PLAN,
          evidence: this.env.AI_REASONING_EFFORT_EVIDENCE,
          final: this.env.AI_REASONING_EFFORT_FINAL,
          aggregate: this.env.AI_REASONING_EFFORT_AGGREGATE,
        },
        evidenceStaleAfterDays: this.env.EVIDENCE_STALE_AFTER_DAYS,
        // 只回報「有沒有設定」。SECRET_ENV_KEYS 已是既有的權威清單，
        // 新增機密變數時這裡會自動跟上，不必記得回來改。
        secretsConfigured: Object.fromEntries(
          SECRET_ENV_KEYS.map((key) => [key, Boolean(this.env[key])]),
        ),
      },
    };
  }

  async update(dto: UpdateSettingsRequest): Promise<SettingsResponse> {
    if (dto.quizDefaults) {
      const current = await this.quizDefaults();
      // 用完整 schema 再驗一次合併結果，而不是只驗傳進來的片段：
      // 部分更新也必須落在合法的組合上。
      const merged = quizDefaultsSchema.parse({ ...current, ...dto.quizDefaults });

      await this.database.db
        .insert(schema.appSettings)
        .values({ key: QUIZ_DEFAULTS_KEY, value: merged })
        .onConflictDoUpdate({
          target: schema.appSettings.key,
          set: { value: merged, updatedAt: new Date() },
        });
    }

    return this.get();
  }

  /** 沒設定過就回 schema 的預設值，不需要事先寫入任何一列。 */
  private async quizDefaults(): Promise<QuizDefaults> {
    const rows = await this.database.db
      .select({ value: schema.appSettings.value })
      .from(schema.appSettings)
      .where(eq(schema.appSettings.key, QUIZ_DEFAULTS_KEY))
      .limit(1);

    const parsed = quizDefaultsSchema.safeParse(rows[0]?.value ?? {});
    return parsed.success ? parsed.data : quizDefaultsSchema.parse({});
  }

  // ------------------------------------------------------------- 維護

  async previewMaintenance(): Promise<MaintenancePreview> {
    const now = new Date();
    const { db } = this.database;

    const [webDocs] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.webDocuments)
      .where(and(isNotNull(schema.webDocuments.expiresAt), lt(schema.webDocuments.expiresAt, now)));

    const [evidenceSets] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.questionEvidenceSets)
      .where(
        and(
          isNotNull(schema.questionEvidenceSets.expiresAt),
          lt(schema.questionEvidenceSets.expiresAt, now),
        ),
      );

    // 沒有任何證據來源引用、且已過期的網頁快取——清掉最安全。
    const [orphans] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.webDocuments)
      .where(
        and(
          isNotNull(schema.webDocuments.expiresAt),
          lt(schema.webDocuments.expiresAt, now),
          sql`not exists (
            select 1 from question_evidence_sources qes
            where qes.url = web_documents.url
          )`,
        ),
      );

    return {
      expiredWebDocuments: webDocs?.n ?? 0,
      expiredEvidenceSets: evidenceSets?.n ?? 0,
      orphanWebDocuments: orphans?.n ?? 0,
    };
  }

  /**
   * 執行清理。
   *
   * 只刪「過期且沒有任何證據集合引用」的網頁快取：
   * 已被引用的來源即使過期也要留著，否則既有解析的引用會變成指向不存在的東西，
   * 而驗收 #16 要求引用必須指向實際存在的來源。
   *
   * 證據集合本身**不刪**，只在此回報數量：它是既有解析的依據，
   * 刪掉等於讓過去的解析失去佐證。過期只代表「不再重複使用」，不代表可以丟棄。
   */
  async cleanup(
    userId: string,
    dto: MaintenanceCleanupRequest,
  ): Promise<MaintenanceCleanupResult> {
    const now = new Date();

    const deletedDocs = await this.database.db
      .delete(schema.webDocuments)
      .where(
        and(
          isNotNull(schema.webDocuments.expiresAt),
          lt(schema.webDocuments.expiresAt, now),
          sql`not exists (
            select 1 from question_evidence_sources qes
            where qes.url = web_documents.url
          )`,
        ),
      )
      .returning({ id: schema.webDocuments.id });

    let recomputed = 0;
    if (dto.recomputeMistakes) {
      recomputed = await this.recomputeAllMistakes(userId);
    }

    this.logger.log(
      `維護作業：清除 ${deletedDocs.length} 筆過期網頁快取；重算 ${recomputed} 筆錯題紀錄`,
    );

    return {
      deletedWebDocuments: deletedDocs.length,
      // 證據集合刻意保留，見上方說明。
      deletedEvidenceSets: 0,
      recomputedMistakeRecords: recomputed,
    };
  }

  /**
   * 依作答歷史重算所有錯題紀錄。
   *
   * 之所以需要這個：錯題紀錄是 `user_answers` 的衍生投影，
   * 而歷史可能因為爭議裁決、題目狀態變更而改變。平時各路徑都會即時重算，
   * 這裡是一個「全部對一遍」的保險，也讓修過 bug 之後有辦法把舊資料補正。
   */
  private async recomputeAllMistakes(userId: string): Promise<number> {
    const questionIds = await this.database.db
      .selectDistinct({ questionId: schema.userAnswers.questionId })
      .from(schema.userAnswers)
      .where(eq(schema.userAnswers.userId, userId));

    await this.database.db.transaction(async (tx) => {
      for (const row of questionIds) {
        await this.mistakeRecords.recompute(tx, userId, row.questionId);
      }
    });

    return questionIds.length;
  }
}
