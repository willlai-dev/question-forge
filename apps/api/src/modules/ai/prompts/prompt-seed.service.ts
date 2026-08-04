import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { AiOperation } from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, eq } from 'drizzle-orm';

import { DATABASE } from '../../../infra/infra.module';
import { PROMPT_VERSIONS, SYSTEM_PROMPTS, USER_TEMPLATES } from './prompt-templates';

/**
 * 把檔案中的 Prompt seed 進 `prompt_versions`。
 *
 * 為什麼要進資料庫：分析結果需要記錄「是哪一版 prompt 產生的」，
 * 這個關聯必須是資料庫層的參照，否則改過 prompt 之後就再也無法解釋舊結果是怎麼來的。
 *
 * 冪等：同一個 (operation, version) 已存在就不動它 ——
 * 內容以檔案為準，但既有列不覆寫，避免歷史結果指向的版本內容被悄悄換掉。
 */
@Injectable()
export class PromptSeedService implements OnModuleInit {
  private readonly logger = new Logger(PromptSeedService.name);

  constructor(@Inject(DATABASE) private readonly database: DatabaseHandle) {}

  async onModuleInit(): Promise<void> {
    await this.seed();
  }

  /**
   * 把檔案中的 prompt 同步進 `prompt_versions`，並確保每個階段恰好一個啟用版本。
   *
   * **停用舊版本必須在插入新版本之前。**
   *
   * 原本的寫法是「先插入（isActive: true）再停用其他」，但
   * `prompt_versions_active_unique` 是 `(operation) WHERE is_active = true` 的
   * 部分唯一索引——插入的當下舊版本還是啟用中，索引立刻擋下，
   * 後面那句 UPDATE 根本執行不到，整個應用啟動失敗。
   *
   * 這個缺陷藏了很久：所有測試資料庫都是全新建立的，沒有舊版本可衝突，
   * 因此直到第一次真正升版才爆出來。**「新裝可以跑」不等於「升級可以跑」。**
   */
  async seed(): Promise<number> {
    const operations = Object.keys(PROMPT_VERSIONS) as AiOperation[];
    let inserted = 0;

    for (const operation of operations) {
      const version = PROMPT_VERSIONS[operation];

      // 整段包在交易裡：中途失敗不能留下「沒有任何啟用版本」的狀態。
      const isNew = await this.database.db.transaction(async (tx) => {
        const existing = await tx
          .select({ id: schema.promptVersions.id, isActive: schema.promptVersions.isActive })
          .from(schema.promptVersions)
          .where(
            and(
              eq(schema.promptVersions.operation, operation),
              eq(schema.promptVersions.version, version),
            ),
          )
          .limit(1);

        const row = existing[0];

        // 這一版已經存在且已啟用：正常重啟的路徑，什麼都不必動。
        if (row?.isActive) return false;

        // 先讓同階段沒有任何啟用版本，索引才不會在下一步擋下來。
        await tx
          .update(schema.promptVersions)
          .set({ isActive: false, updatedAt: new Date() })
          .where(
            and(
              eq(schema.promptVersions.operation, operation),
              eq(schema.promptVersions.isActive, true),
            ),
          );

        // 版本號被改回舊版（回退）時，重新啟用既有那一列而不是插新的。
        // 內容以資料庫既有的為準，不覆寫——歷史結果指向的版本內容不該被悄悄換掉。
        if (row) {
          await tx
            .update(schema.promptVersions)
            .set({ isActive: true, updatedAt: new Date() })
            .where(eq(schema.promptVersions.id, row.id));
          return false;
        }

        await tx.insert(schema.promptVersions).values({
          operation,
          version,
          systemPrompt: SYSTEM_PROMPTS[operation],
          userTemplate: USER_TEMPLATES[operation],
          isActive: true,
        });
        return true;
      });

      if (isNew) inserted += 1;
    }

    if (inserted > 0) this.logger.log(`Prompt 版本：新增 ${inserted} 筆`);
    return inserted;
  }

  /** 取得目前啟用的版本號，寫進分析結果供日後追溯。 */
  activeVersion(operation: AiOperation): string {
    return PROMPT_VERSIONS[operation];
  }
}
