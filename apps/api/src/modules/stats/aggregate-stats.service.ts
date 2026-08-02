import { Inject, Injectable } from '@nestjs/common';
import {
  classifyTrend,
  computeCurrentWrongStreaks,
  percent,
  selectRepresentativeQuestions,
  type AggregateStats,
  type AggregateStatsResponse,
  type RepresentativeCandidate,
  type RepresentativeQuestion,
  type StreakAttempt,
  type TagWeight,
} from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { diagnosableQuestion, diagnosticScope } from '../../common/diagnostic-scope';
import { DATABASE } from '../../infra/infra.module';

/**
 * 多題整合分析的統計層（規格 §11、FR-AGG-01～03）。
 *
 * **這一層完全不呼叫 AI。** 規格要求「先由 PostgreSQL 完成統計彙總，
 * 再挑選代表錯題交給模型」，所以這裡算完的結果既是 prompt 的輸入，
 * 也是 `GET /stats/aggregate` 直接回給前端的內容——
 * 因此整條統計邏輯可以在不花任何 AI 額度的情況下被端到端測試。
 *
 * 放在 StatsModule 而不是 AiModule：統計是 AI 的輸入，
 * 擺進 AI 模組會變成不啟動整套 AI 就無法驗證統計是否正確。
 */
@Injectable()
export class AggregateStatsService {
  constructor(@Inject(DATABASE) private readonly database: DatabaseHandle) {}

  async collect(
    userId: string,
    period: { from: Date; to: Date },
  ): Promise<AggregateStatsResponse> {
    // 期間中點只算一次，綁進每一支查詢，確保所有趨勢數字切在同一瞬間。
    const mid = new Date((period.from.getTime() + period.to.getTime()) / 2);
    const scope = diagnosticScope(userId, period);

    // 整份統計包在單一唯讀交易內：中途有人交卷會破壞
    // 「各維度加總 === overall」這條測試依賴的不變量。
    // read only 是額外保險——統計層在物理上無法寫入。
    return this.database.db.transaction(
      async (tx) => {
        const overall = await this.collectOverall(tx, scope);
        const bySubject = await this.collectBySubject(tx, scope);
        const byChapter = await this.collectByChapter(tx, scope);
        const byQuestionGroup = await this.collectByQuestionGroup(tx, scope);
        const { byKnowledgeTag, improved, notImproved } = await this.collectByKnowledgeTag(
          tx,
          scope,
          mid,
        );
        const knowledgeTagCoverage = await this.collectTagCoverage(tx, scope, overall.totalAnswered);
        const byErrorType = await this.collectByErrorType(tx, userId);
        const consecutiveWrongStreaks = await this.collectStreaks(tx, scope);
        const recentAccuracyChange = await this.collectRecentChange(tx, scope, mid);

        const stats: AggregateStats = {
          period: {
            from: period.from.toISOString(),
            to: period.to.toISOString(),
            mid: mid.toISOString(),
            generatedAt: new Date().toISOString(),
          },
          overall,
          bySubject,
          byChapter,
          byQuestionGroup,
          byKnowledgeTag,
          knowledgeTagCoverage,
          byErrorType,
          errorTypeWindow: 'lifetime',
          consecutiveWrongStreaks,
          recentAccuracyChange,
          improved,
          notImproved,
        };

        const representativeQuestions = await this.selectRepresentatives(
          tx,
          userId,
          scope,
          byKnowledgeTag,
        );

        return { stats, representativeQuestions };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  // ------------------------------------------------------------- 各項統計

  /**
   * 總體數字。
   *
   * **這支查詢刻意不 join `question_knowledge_tags`。** 一題可掛 1 主 2 次知識點，
   * 一旦 join 就會把同一筆作答放大成三列。防止扇出污染總數的做法不是 DISTINCT，
   * 而是讓 overall 永遠獨立計算、絕不由標籤統計加總得出。
   */
  private async collectOverall(tx: Tx, scope: ReturnType<typeof diagnosticScope>) {
    const [row] = await tx
      .select({
        totalAnswered: sql<number>`count(*)::int`,
        correct: sql<number>`count(*) filter (where ${schema.userAnswers.isCorrect})::int`,
        avgResponseTimeMs: sql<number | null>`avg(${schema.userAnswers.responseTimeMs})::int`,
        // 作答時間可為 null，avg() 會靜靜略過。只看平均會把「3 筆樣本」講得像全部。
        responseTimeSamples: sql<number>`count(${schema.userAnswers.responseTimeMs})::int`,
      })
      .from(schema.userAnswers)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.userAnswers.questionId))
      .where(scope);

    const totalAnswered = row?.totalAnswered ?? 0;
    const correct = row?.correct ?? 0;
    return {
      totalAnswered,
      correct,
      accuracy: percent(correct, totalAnswered),
      avgResponseTimeMs: row?.avgResponseTimeMs ?? null,
      responseTimeSamples: row?.responseTimeSamples ?? 0,
    };
  }

  private async collectBySubject(tx: Tx, scope: ReturnType<typeof diagnosticScope>) {
    const rows = await tx
      .select({
        id: schema.subjects.id,
        name: schema.subjects.name,
        answered: sql<number>`count(*)::int`,
        correct: sql<number>`count(*) filter (where ${schema.userAnswers.isCorrect})::int`,
      })
      .from(schema.userAnswers)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.userAnswers.questionId))
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questions.subjectId))
      .where(scope)
      .groupBy(schema.subjects.id, schema.subjects.name)
      // 名稱是必要的平手條件，否則同數量的桶順序由資料庫決定，結果就不可重現。
      .orderBy(desc(sql`count(*)`), asc(schema.subjects.name));

    return rows.map((row) => ({ ...row, accuracy: percent(row.correct, row.answered) }));
  }

  /**
   * 章節。`questions.chapter_id` 可為 null，因此用 LEFT JOIN 並補一個「未分章節」桶。
   * 該桶**依科目分開**：把不同科目的未分章節題目併成一桶，使用者無法據此行動。
   */
  private async collectByChapter(tx: Tx, scope: ReturnType<typeof diagnosticScope>) {
    const rows = await tx
      .select({
        chapterId: schema.chapters.id,
        chapterName: schema.chapters.name,
        subjectId: schema.subjects.id,
        subjectName: schema.subjects.name,
        answered: sql<number>`count(*)::int`,
        correct: sql<number>`count(*) filter (where ${schema.userAnswers.isCorrect})::int`,
      })
      .from(schema.userAnswers)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.userAnswers.questionId))
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questions.subjectId))
      .leftJoin(schema.chapters, eq(schema.chapters.id, schema.questions.chapterId))
      .where(scope)
      .groupBy(
        schema.chapters.id,
        schema.chapters.name,
        schema.subjects.id,
        schema.subjects.name,
      )
      .orderBy(desc(sql`count(*)`), asc(schema.subjects.name));

    return rows.map((row) => ({
      // 'none:' 前綴沿用錯題列表既有的 chapterId=none 語意，
      // 讓推薦的複習目標可以直接轉成一個真的重練場次。
      id: row.chapterId ?? `none:${row.subjectId}`,
      name: row.chapterName ?? `${row.subjectName} · 未分章節`,
      answered: row.answered,
      correct: row.correct,
      accuracy: percent(row.correct, row.answered),
    }));
  }

  private async collectByQuestionGroup(tx: Tx, scope: ReturnType<typeof diagnosticScope>) {
    const rows = await tx
      .select({
        id: schema.questionGroups.id,
        name: schema.questionGroups.name,
        answered: sql<number>`count(*)::int`,
        correct: sql<number>`count(*) filter (where ${schema.userAnswers.isCorrect})::int`,
      })
      .from(schema.userAnswers)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.userAnswers.questionId))
      .innerJoin(
        schema.questionGroups,
        eq(schema.questionGroups.id, schema.questions.questionGroupId),
      )
      .where(scope)
      .groupBy(schema.questionGroups.id, schema.questionGroups.name)
      .orderBy(desc(sql`count(*)`), asc(schema.questionGroups.name));

    return rows.map((row) => ({ ...row, accuracy: percent(row.correct, row.answered) }));
  }

  /**
   * 知識點。這是唯一會 join `question_knowledge_tags` 的正確率查詢。
   *
   * 一筆作答若掛 1 主 2 次知識點，會在三個標籤桶各算一次——對「單一標籤的正確率」
   * 這是正確的；改成只算主要知識點，次要標籤就永遠不會出現在診斷裡，
   * 那等於白設次要標籤。放大只存在於這支查詢的結果集內，不影響其他維度。
   *
   * 合併過的標籤不需要在這裡解析：合併時 `transferQuestionLinks` 已把關聯搬到目標標籤，
   * 而兩個寫入路徑都拒收 `status = 'merged'` 的標籤，因此關聯不可能指向已合併的標籤。
   */
  private async collectByKnowledgeTag(
    tx: Tx,
    scope: ReturnType<typeof diagnosticScope>,
    mid: Date,
  ) {
    const rows = await tx
      .select({
        id: schema.knowledgeTags.id,
        name: schema.knowledgeTags.name,
        answered: sql<number>`count(*)::int`,
        correct: sql<number>`count(*) filter (where ${schema.userAnswers.isCorrect})::int`,
        primaryAnswered: sql<number>`count(*) filter (where ${schema.questionKnowledgeTags.role} = 'primary')::int`,
        earlierAnswered: sql<number>`count(*) filter (where ${schema.userAnswers.answeredAt} < ${mid})::int`,
        earlierCorrect: sql<number>`count(*) filter (where ${schema.userAnswers.answeredAt} < ${mid} and ${schema.userAnswers.isCorrect})::int`,
        recentAnswered: sql<number>`count(*) filter (where ${schema.userAnswers.answeredAt} >= ${mid})::int`,
        recentCorrect: sql<number>`count(*) filter (where ${schema.userAnswers.answeredAt} >= ${mid} and ${schema.userAnswers.isCorrect})::int`,
      })
      .from(schema.userAnswers)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.userAnswers.questionId))
      .innerJoin(
        schema.questionKnowledgeTags,
        eq(schema.questionKnowledgeTags.questionId, schema.userAnswers.questionId),
      )
      .innerJoin(
        schema.knowledgeTags,
        eq(schema.knowledgeTags.id, schema.questionKnowledgeTags.knowledgeTagId),
      )
      .where(scope)
      .groupBy(schema.knowledgeTags.id, schema.knowledgeTags.name)
      .orderBy(desc(sql`count(*)`), asc(schema.knowledgeTags.name));

    const improved: string[] = [];
    const notImproved: string[] = [];

    const byKnowledgeTag = rows.map((row) => {
      const { trend, verdict } = classifyTrend({
        earlierAnswered: row.earlierAnswered,
        earlierCorrect: row.earlierCorrect,
        recentAnswered: row.recentAnswered,
        recentCorrect: row.recentCorrect,
      });
      // stable_ok 與 insufficient 兩邊都不列入：停在 85% 不需要提醒，
      // 只有 3 筆資料也構不成證據。
      if (verdict === 'improved') improved.push(row.name);
      if (verdict === 'not_improved') notImproved.push(row.name);

      return {
        id: row.id,
        name: row.name,
        answered: row.answered,
        correct: row.correct,
        accuracy: percent(row.correct, row.answered),
        primaryAnswered: row.primaryAnswered,
        trend,
        trendVerdict: verdict,
      };
    });

    return { byKnowledgeTag, improved, notImproved };
  }

  private async collectTagCoverage(
    tx: Tx,
    scope: ReturnType<typeof diagnosticScope>,
    totalAnswered: number,
  ) {
    const [row] = await tx
      .select({
        taggedAnswered: sql<number>`count(distinct ${schema.userAnswers.id})::int`,
      })
      .from(schema.userAnswers)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.userAnswers.questionId))
      .innerJoin(
        schema.questionKnowledgeTags,
        eq(schema.questionKnowledgeTags.questionId, schema.userAnswers.questionId),
      )
      .where(scope);

    return { taggedAnswered: row?.taggedAnswered ?? 0, totalAnswered };
  }

  /**
   * 錯誤類型次數。這張表沒有 user_id，得經 mistake_records 取得歸屬，
   * 再經 questions 套用診斷判準。
   *
   * **終身統計**：來源沒有逐次發生的時間戳，硬套期間條件只會得到一個假的數字。
   */
  private async collectByErrorType(tx: Tx, userId: string) {
    const rows = await tx
      .select({
        code: schema.errorTypes.code,
        name: schema.errorTypes.name,
        count: sql<number>`sum(${schema.mistakeRecordErrorTypes.occurrenceCount})::int`,
        questionCount: sql<number>`count(*)::int`,
      })
      .from(schema.mistakeRecordErrorTypes)
      .innerJoin(
        schema.mistakeRecords,
        eq(schema.mistakeRecords.id, schema.mistakeRecordErrorTypes.mistakeRecordId),
      )
      .innerJoin(schema.questions, eq(schema.questions.id, schema.mistakeRecords.questionId))
      .innerJoin(
        schema.errorTypes,
        eq(schema.errorTypes.id, schema.mistakeRecordErrorTypes.errorTypeId),
      )
      .where(and(eq(schema.mistakeRecords.userId, userId), diagnosableQuestion()))
      .groupBy(schema.errorTypes.id, schema.errorTypes.code, schema.errorTypes.name)
      .orderBy(
        desc(sql`sum(${schema.mistakeRecordErrorTypes.occurrenceCount})`),
        asc(schema.errorTypes.sortOrder),
      );

    return rows;
  }

  private async collectStreaks(tx: Tx, scope: ReturnType<typeof diagnosticScope>) {
    // 由新到舊，排序與 MistakeRecordsService.recompute 的 (answered_at, id) 相反方向一致。
    const rows = await tx
      .select({
        knowledgeTagId: schema.knowledgeTags.id,
        knowledgeTagName: schema.knowledgeTags.name,
        isCorrect: schema.userAnswers.isCorrect,
      })
      .from(schema.userAnswers)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.userAnswers.questionId))
      .innerJoin(
        schema.questionKnowledgeTags,
        eq(schema.questionKnowledgeTags.questionId, schema.userAnswers.questionId),
      )
      .innerJoin(
        schema.knowledgeTags,
        eq(schema.knowledgeTags.id, schema.questionKnowledgeTags.knowledgeTagId),
      )
      .where(scope)
      .orderBy(desc(schema.userAnswers.answeredAt), desc(schema.userAnswers.id));

    return computeCurrentWrongStreaks(rows satisfies StreakAttempt[]);
  }

  private async collectRecentChange(
    tx: Tx,
    scope: ReturnType<typeof diagnosticScope>,
    mid: Date,
  ) {
    const [row] = await tx
      .select({
        previousAnswered: sql<number>`count(*) filter (where ${schema.userAnswers.answeredAt} < ${mid})::int`,
        previousCorrect: sql<number>`count(*) filter (where ${schema.userAnswers.answeredAt} < ${mid} and ${schema.userAnswers.isCorrect})::int`,
        currentAnswered: sql<number>`count(*) filter (where ${schema.userAnswers.answeredAt} >= ${mid})::int`,
        currentCorrect: sql<number>`count(*) filter (where ${schema.userAnswers.answeredAt} >= ${mid} and ${schema.userAnswers.isCorrect})::int`,
      })
      .from(schema.userAnswers)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.userAnswers.questionId))
      .where(scope);

    const input = {
      earlierAnswered: row?.previousAnswered ?? 0,
      earlierCorrect: row?.previousCorrect ?? 0,
      recentAnswered: row?.currentAnswered ?? 0,
      recentCorrect: row?.currentCorrect ?? 0,
    };
    const { trend, verdict, earlierAccuracy, recentAccuracy } = classifyTrend(input);

    return {
      previousAnswered: input.earlierAnswered,
      previous: earlierAccuracy,
      currentAnswered: input.recentAnswered,
      current: recentAccuracy,
      delta: trend,
      verdict,
    };
  }

  // ------------------------------------------------------------- 代表錯題

  /**
   * 挑出代表錯題（FR-AGG-03）。挑選規則本身是 contracts 裡的純函式，
   * 這裡只負責把候選資料撈齊、以及把結果補上顯示用的欄位。
   */
  private async selectRepresentatives(
    tx: Tx,
    userId: string,
    scope: ReturnType<typeof diagnosticScope>,
    tagStats: Array<{ id: string; accuracy: number | null; answered: number }>,
  ): Promise<RepresentativeQuestion[]> {
    const rows = await tx
      .select({
        questionId: schema.userAnswers.questionId,
        questionNumber: schema.questions.questionNumber,
        stem: schema.questions.stem,
        subjectName: schema.subjects.name,
        attemptCount: sql<number>`count(*)::int`,
        wrongCount: sql<number>`count(*) filter (where not ${schema.userAnswers.isCorrect})::int`,
        lastMissedAt: sql<Date | null>`max(${schema.userAnswers.answeredAt}) filter (where not ${schema.userAnswers.isCorrect})`,
        masteryState: sql<string | null>`max(${schema.mistakeRecords.masteryState})`,
      })
      .from(schema.userAnswers)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.userAnswers.questionId))
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questions.subjectId))
      .leftJoin(
        schema.mistakeRecords,
        and(
          eq(schema.mistakeRecords.questionId, schema.userAnswers.questionId),
          eq(schema.mistakeRecords.userId, userId),
        ),
      )
      .where(scope)
      .groupBy(
        schema.userAnswers.questionId,
        schema.questions.questionNumber,
        schema.questions.stem,
        schema.subjects.name,
      )
      // 只有答錯過的題目才有資格當代表錯題。
      .having(sql`count(*) filter (where not ${schema.userAnswers.isCorrect}) > 0`);

    if (rows.length === 0) return [];

    const questionIds = rows.map((row) => row.questionId);
    const tagsByQuestion = await this.loadTagsByQuestion(tx, questionIds);
    const errorCodesByQuestion = await this.loadErrorCodesByQuestion(tx, userId, questionIds);

    const candidates: RepresentativeCandidate[] = rows.map((row) => {
      const tags = tagsByQuestion.get(row.questionId);
      return {
        questionId: row.questionId,
        wrongCount: row.wrongCount,
        attemptCount: row.attemptCount,
        masteryState:
          (row.masteryState as RepresentativeCandidate['masteryState'] | null) ?? 'active',
        knowledgeTagIds: tags?.ids ?? [],
        primaryKnowledgeTagId: tags?.primaryId ?? null,
        errorTypeCodes: errorCodesByQuestion.get(row.questionId) ?? [],
        lastMissedAt: row.lastMissedAt ? new Date(row.lastMissedAt).toISOString() : null,
        questionNumber: row.questionNumber,
      };
    });

    const weights: TagWeight[] = tagStats.map((tag) => ({
      tagId: tag.id,
      accuracy: tag.accuracy,
      answered: tag.answered,
    }));

    const selection = selectRepresentativeQuestions({ candidates, tagStats: weights });
    if (selection.questionIds.length === 0) return [];

    const detailById = new Map(rows.map((row) => [row.questionId, row]));
    const answersById = await this.loadLatestWrongAnswers(tx, userId, selection.questionIds);
    const correctById = await this.loadCorrectAnswers(tx, selection.questionIds);

    return selection.scored.map((scored) => {
      const detail = detailById.get(scored.questionId)!;
      const tags = tagsByQuestion.get(scored.questionId);
      return {
        questionId: scored.questionId,
        questionNumber: detail.questionNumber,
        stem: detail.stem,
        subjectName: detail.subjectName,
        knowledgeTagNames: tags?.names ?? [],
        errorTypeCodes: errorCodesByQuestion.get(scored.questionId) ?? [],
        wrongCount: detail.wrongCount,
        attemptCount: detail.attemptCount,
        lastSelectedAnswers: answersById.get(scored.questionId) ?? [],
        correctAnswers: correctById.get(scored.questionId) ?? [],
        score: scored.score,
        reasons: scored.reasons,
      };
    });
  }

  private async loadTagsByQuestion(tx: Tx, questionIds: string[]) {
    const rows = await tx
      .select({
        questionId: schema.questionKnowledgeTags.questionId,
        tagId: schema.knowledgeTags.id,
        tagName: schema.knowledgeTags.name,
        role: schema.questionKnowledgeTags.role,
      })
      .from(schema.questionKnowledgeTags)
      .innerJoin(
        schema.knowledgeTags,
        eq(schema.knowledgeTags.id, schema.questionKnowledgeTags.knowledgeTagId),
      )
      .where(inArray(schema.questionKnowledgeTags.questionId, questionIds))
      .orderBy(asc(schema.knowledgeTags.name));

    const map = new Map<string, { ids: string[]; names: string[]; primaryId: string | null }>();
    for (const row of rows) {
      const entry = map.get(row.questionId) ?? { ids: [], names: [], primaryId: null };
      entry.ids.push(row.tagId);
      entry.names.push(row.tagName);
      if (row.role === 'primary') entry.primaryId = row.tagId;
      map.set(row.questionId, entry);
    }
    return map;
  }

  private async loadErrorCodesByQuestion(tx: Tx, userId: string, questionIds: string[]) {
    const rows = await tx
      .select({
        questionId: schema.mistakeRecords.questionId,
        code: schema.errorTypes.code,
      })
      .from(schema.mistakeRecordErrorTypes)
      .innerJoin(
        schema.mistakeRecords,
        eq(schema.mistakeRecords.id, schema.mistakeRecordErrorTypes.mistakeRecordId),
      )
      .innerJoin(
        schema.errorTypes,
        eq(schema.errorTypes.id, schema.mistakeRecordErrorTypes.errorTypeId),
      )
      .where(
        and(
          eq(schema.mistakeRecords.userId, userId),
          inArray(schema.mistakeRecords.questionId, questionIds),
        ),
      )
      .orderBy(asc(schema.errorTypes.sortOrder));

    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.questionId) ?? [];
      list.push(row.code);
      map.set(row.questionId, list);
    }
    return map;
  }

  /** 最近一次答錯時選了什麼——讓 AI 看得到使用者的實際誤選。 */
  private async loadLatestWrongAnswers(tx: Tx, userId: string, questionIds: string[]) {
    const rows = await tx
      .select({
        questionId: schema.userAnswers.questionId,
        selectedAnswers: schema.userAnswers.selectedAnswers,
        answeredAt: schema.userAnswers.answeredAt,
      })
      .from(schema.userAnswers)
      .where(
        and(
          eq(schema.userAnswers.userId, userId),
          eq(schema.userAnswers.isCorrect, false),
          inArray(schema.userAnswers.questionId, questionIds),
        ),
      )
      .orderBy(desc(schema.userAnswers.answeredAt), desc(schema.userAnswers.id));

    const map = new Map<string, string[]>();
    for (const row of rows) {
      if (!map.has(row.questionId)) map.set(row.questionId, row.selectedAnswers);
    }
    return map;
  }

  private async loadCorrectAnswers(tx: Tx, questionIds: string[]) {
    const rows = await tx
      .select({
        questionId: schema.questionOptions.questionId,
        key: schema.questionOptions.key,
      })
      .from(schema.questionOptions)
      .where(
        and(
          inArray(schema.questionOptions.questionId, questionIds),
          eq(schema.questionOptions.isCorrect, true),
        ),
      )
      .orderBy(asc(schema.questionOptions.sortOrder));

    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.questionId) ?? [];
      list.push(row.key);
      map.set(row.questionId, list);
    }
    return map;
  }
}

/** 交易 handle 的型別。 */
type Tx = Parameters<Parameters<DatabaseHandle['db']['transaction']>[0]>[0];
