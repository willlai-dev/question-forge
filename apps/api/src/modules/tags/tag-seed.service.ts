import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ERROR_TYPE_SEEDS, SKILL_TAG_SEEDS, toTagSlug } from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';

import { DATABASE } from '../../infra/infra.module';

/**
 * 受控詞彙的種子資料寫入。
 *
 * 在啟動時自動執行，而不是提供一支手動腳本：使用者只需要填三個環境變數就能啟動，
 * 多一個「別忘了跑 seed」的步驟就多一種系統看起來壞掉的方式。
 *
 * **只新增、不覆寫**（`onConflictDoNothing`）。使用者把「概念混淆」改成別的名稱後，
 * 下次啟動不會被種子資料改回去 —— 種子是初始值，不是強制值。
 * 對應的識別鍵是 `error_types.code` 與 `skill_tags.slug`，改名不影響。
 */
@Injectable()
export class TagSeedService implements OnModuleInit {
  private readonly logger = new Logger(TagSeedService.name);

  constructor(@Inject(DATABASE) private readonly database: DatabaseHandle) {}

  async onModuleInit(): Promise<void> {
    await this.seed();
  }

  async seed(): Promise<{ skillTagsInserted: number; errorTypesInserted: number }> {
    const { db } = this.database;

    const skills = await db
      .insert(schema.skillTags)
      .values(
        SKILL_TAG_SEEDS.map((seed, index) => ({
          name: seed.name,
          slug: toTagSlug(seed.slug),
          description: seed.description,
          sortOrder: index,
        })),
      )
      .onConflictDoNothing({ target: schema.skillTags.slug })
      .returning({ id: schema.skillTags.id });

    const errors = await db
      .insert(schema.errorTypes)
      .values(
        ERROR_TYPE_SEEDS.map((seed, index) => ({
          code: seed.code,
          name: seed.name,
          description: seed.description,
          sortOrder: index,
          isFallback: seed.isFallback,
        })),
      )
      .onConflictDoNothing({ target: schema.errorTypes.code })
      .returning({ id: schema.errorTypes.id });

    if (skills.length > 0 || errors.length > 0) {
      this.logger.log(`種子資料：新增 ${skills.length} 種能力類型、${errors.length} 種錯誤類型`);
    }

    return { skillTagsInserted: skills.length, errorTypesInserted: errors.length };
  }
}
