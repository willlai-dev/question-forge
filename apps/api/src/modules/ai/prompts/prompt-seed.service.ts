import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { AiOperation } from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, eq, ne } from 'drizzle-orm';

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

  async seed(): Promise<number> {
    const operations = Object.keys(PROMPT_VERSIONS) as AiOperation[];
    let inserted = 0;

    for (const operation of operations) {
      const version = PROMPT_VERSIONS[operation];

      const rows = await this.database.db
        .insert(schema.promptVersions)
        .values({
          operation,
          version,
          systemPrompt: SYSTEM_PROMPTS[operation],
          userTemplate: USER_TEMPLATES[operation],
          isActive: true,
        })
        .onConflictDoNothing({
          target: [schema.promptVersions.operation, schema.promptVersions.version],
        })
        .returning({ id: schema.promptVersions.id });

      if (rows.length === 0) continue;
      inserted += 1;

      // 每個階段同時只能有一個啟用版本（資料庫也有部分唯一索引把關）。
      // 新版本插入後，把同階段的其他版本停用。
      await this.database.db
        .update(schema.promptVersions)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            eq(schema.promptVersions.operation, operation),
            ne(schema.promptVersions.id, rows[0]!.id),
          ),
        );
    }

    if (inserted > 0) this.logger.log(`Prompt 版本：新增 ${inserted} 筆`);
    return inserted;
  }

  /** 取得目前啟用的版本號，寫進分析結果供日後追溯。 */
  activeVersion(operation: AiOperation): string {
    return PROMPT_VERSIONS[operation];
  }
}
