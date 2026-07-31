import { Inject, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  SECONDARY_KNOWLEDGE_TAG_MAX,
  SECONDARY_SKILL_TAG_MAX,
  type QuestionTagResponse,
  type SetQuestionTagsRequest,
} from '@repo/contracts';
import { schema, type Database, type DatabaseHandle } from '@repo/db';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { DATABASE } from '../../infra/infra.module';

export interface QuestionTags {
  knowledgeTags: QuestionTagResponse[];
  skillTags: QuestionTagResponse[];
}

/**
 * 題目的標籤關聯。
 *
 * 「主要 1 個、次要最多 2 個」有三層把關，刻意重複：
 *   1. contract 的 `max(2)` —— 前端表單即時擋下，錯誤訊息最清楚。
 *   2. 本 service 的檢查 —— 擋下繞過前端的請求，並確認標籤真的存在且可用。
 *   3. 資料庫的部分唯一索引 `(question_id) WHERE role = 'primary'` —— 最後防線，
 *      即使日後有人寫了新的寫入路徑而忘了檢查，資料仍不會壞掉。
 *
 * 標籤變更**不會**遞增題目版本，也不影響 content_hash：標籤是對題目的標註，
 * 不是題目內容。走 `PATCH /questions/:id` 會連帶寫版本快照，那是錯的。
 */
@Injectable()
export class QuestionTagsService {
  constructor(@Inject(DATABASE) private readonly database: DatabaseHandle) {}

  async get(userId: string, questionId: string): Promise<QuestionTags> {
    await this.assertQuestionExists(userId, questionId);
    const map = await this.loadForQuestions(this.database.db, [questionId]);
    return map.get(questionId) ?? { knowledgeTags: [], skillTags: [] };
  }

  async set(
    userId: string,
    questionId: string,
    dto: SetQuestionTagsRequest,
  ): Promise<QuestionTags> {
    await this.assertQuestionExists(userId, questionId);

    const knowledgeIds = [
      ...(dto.primaryKnowledgeTagId ? [dto.primaryKnowledgeTagId] : []),
      ...dto.secondaryKnowledgeTagIds,
    ];
    const skillIds = [
      ...(dto.primarySkillTagId ? [dto.primarySkillTagId] : []),
      ...dto.secondarySkillTagIds,
    ];

    if (dto.secondaryKnowledgeTagIds.length > SECONDARY_KNOWLEDGE_TAG_MAX) {
      throw new AppException(
        ERROR_CODES.TAG_SECONDARY_LIMIT_EXCEEDED,
        `次要知識點最多 ${SECONDARY_KNOWLEDGE_TAG_MAX} 個。`,
      );
    }
    if (dto.secondarySkillTagIds.length > SECONDARY_SKILL_TAG_MAX) {
      throw new AppException(
        ERROR_CODES.TAG_SECONDARY_LIMIT_EXCEEDED,
        `次要能力類型最多 ${SECONDARY_SKILL_TAG_MAX} 個。`,
      );
    }

    await this.assertKnowledgeTagsUsable(userId, knowledgeIds);
    await this.assertSkillTagsUsable(skillIds);

    await this.database.db.transaction(async (tx) => {
      // 整組換掉。標籤是一個集合，逐一 diff 沒有實益，而且容易在
      // 「主要換成次要」這種情境下短暫違反部分唯一索引。
      await tx
        .delete(schema.questionKnowledgeTags)
        .where(eq(schema.questionKnowledgeTags.questionId, questionId));
      await tx
        .delete(schema.questionSkillTags)
        .where(eq(schema.questionSkillTags.questionId, questionId));

      if (knowledgeIds.length > 0) {
        await tx.insert(schema.questionKnowledgeTags).values(
          knowledgeIds.map((tagId) => ({
            questionId,
            knowledgeTagId: tagId,
            role: tagId === dto.primaryKnowledgeTagId ? 'primary' : 'secondary',
            source: 'manual',
          })),
        );
      }

      if (skillIds.length > 0) {
        await tx.insert(schema.questionSkillTags).values(
          skillIds.map((tagId) => ({
            questionId,
            skillTagId: tagId,
            role: tagId === dto.primarySkillTagId ? 'primary' : 'secondary',
            source: 'manual',
          })),
        );
      }
    });

    return this.get(userId, questionId);
  }

  /** 批次載入多題的標籤，供題目列表使用（避免 N+1）。 */
  async loadForQuestions(
    db: Database,
    questionIds: string[],
  ): Promise<Map<string, QuestionTags>> {
    const result = new Map<string, QuestionTags>();
    if (questionIds.length === 0) return result;

    const [knowledge, skills] = await Promise.all([
      db
        .select({
          questionId: schema.questionKnowledgeTags.questionId,
          id: schema.knowledgeTags.id,
          name: schema.knowledgeTags.name,
          role: schema.questionKnowledgeTags.role,
          source: schema.questionKnowledgeTags.source,
          confidence: schema.questionKnowledgeTags.confidence,
        })
        .from(schema.questionKnowledgeTags)
        .innerJoin(
          schema.knowledgeTags,
          eq(schema.knowledgeTags.id, schema.questionKnowledgeTags.knowledgeTagId),
        )
        .where(inArray(schema.questionKnowledgeTags.questionId, questionIds)),
      db
        .select({
          questionId: schema.questionSkillTags.questionId,
          id: schema.skillTags.id,
          name: schema.skillTags.name,
          role: schema.questionSkillTags.role,
          source: schema.questionSkillTags.source,
          confidence: schema.questionSkillTags.confidence,
        })
        .from(schema.questionSkillTags)
        .innerJoin(schema.skillTags, eq(schema.skillTags.id, schema.questionSkillTags.skillTagId))
        .where(inArray(schema.questionSkillTags.questionId, questionIds)),
    ]);

    const toResponse = (row: {
      id: string;
      name: string;
      role: string;
      source: string;
      confidence: string | null;
    }): QuestionTagResponse => ({
      id: row.id,
      name: row.name,
      role: row.role as QuestionTagResponse['role'],
      source: row.source as QuestionTagResponse['source'],
      confidence: row.confidence === null ? null : Number(row.confidence),
    });

    for (const questionId of questionIds) {
      result.set(questionId, { knowledgeTags: [], skillTags: [] });
    }
    // 主要標籤排在前面，前端不必自行排序。
    const byRole = (a: { role: string }, b: { role: string }) =>
      a.role === b.role ? 0 : a.role === 'primary' ? -1 : 1;

    for (const row of [...knowledge].sort(byRole)) {
      result.get(row.questionId)?.knowledgeTags.push(toResponse(row));
    }
    for (const row of [...skills].sort(byRole)) {
      result.get(row.questionId)?.skillTags.push(toResponse(row));
    }

    return result;
  }

  // ------------------------------------------------------------- helpers

  private async assertQuestionExists(userId: string, questionId: string): Promise<void> {
    const rows = await this.database.db
      .select({ id: schema.questions.id })
      .from(schema.questions)
      .where(
        and(
          eq(schema.questions.id, questionId),
          eq(schema.questions.userId, userId),
          isNull(schema.questions.deletedAt),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new AppException(ERROR_CODES.QUESTION_NOT_FOUND, '找不到指定的題目。');
    }
  }

  /** 已停用或已合併的標籤不能再掛到題目上（既有關聯不受影響）。 */
  private async assertKnowledgeTagsUsable(userId: string, tagIds: string[]): Promise<void> {
    if (tagIds.length === 0) return;

    const rows = await this.database.db
      .select({ id: schema.knowledgeTags.id, status: schema.knowledgeTags.status })
      .from(schema.knowledgeTags)
      .where(
        and(
          eq(schema.knowledgeTags.userId, userId),
          inArray(schema.knowledgeTags.id, tagIds),
          ne(schema.knowledgeTags.status, 'merged'),
        ),
      );

    const found = new Set(rows.map((row) => row.id));
    const missing = tagIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new AppException(
        ERROR_CODES.TAG_NOT_FOUND,
        '指定的知識點不存在、已被合併，或不屬於你。',
      );
    }

    const deprecated = rows.filter((row) => row.status === 'deprecated');
    if (deprecated.length > 0) {
      throw new AppException(ERROR_CODES.CONFLICT, '已停用的知識點不能再掛到題目上。');
    }
  }

  private async assertSkillTagsUsable(tagIds: string[]): Promise<void> {
    if (tagIds.length === 0) return;

    const rows = await this.database.db
      .select({ id: schema.skillTags.id, status: schema.skillTags.status })
      .from(schema.skillTags)
      .where(inArray(schema.skillTags.id, tagIds));

    const found = new Set(rows.map((row) => row.id));
    const missing = tagIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new AppException(ERROR_CODES.TAG_NOT_FOUND, '指定的能力類型不存在。');
    }

    if (rows.some((row) => row.status !== 'active')) {
      throw new AppException(ERROR_CODES.CONFLICT, '已停用的能力類型不能再掛到題目上。');
    }
  }
}
