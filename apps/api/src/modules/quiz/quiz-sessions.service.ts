import { Inject, Injectable } from '@nestjs/common';
import {
  applyOrderStrategy,
  buildOptionOrder,
  ERROR_CODES,
  generateSessionSeed,
  gradeAnswer,
  normalizeAnswerKeys,
  type CreateQuizSessionRequest,
  type ListQuizSessionsQuery,
  type PaginationMeta,
  type QuizOutlineResponse,
  type QuizQuestionResponse,
  type QuizResultResponse,
  type QuizReveal,
  type QuizSessionResponse,
  type SubmitAnswerRequest,
  type SubmitAnswerResponse,
  type UpdateAnswerRequest,
} from '@repo/contracts';
import { schema, type Database, type DatabaseHandle } from '@repo/db';
import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';

import { AppException } from '../../common/app.exception';
import { DATABASE } from '../../infra/infra.module';
import { MistakeRecordsService } from './mistake-records.service';

type SessionRow = typeof schema.quizSessions.$inferSelect;

/** 導覽列題幹預覽的長度。導覽列是用來「認出是哪一題」，不是用來讀題的。 */
const OUTLINE_STEM_PREVIEW_CHARS = 60;

/** 建立場次時，出題引擎需要知道的題目資訊。 */
interface CandidateQuestion {
  id: string;
  currentVersion: number;
}

@Injectable()
export class QuizSessionsService {
  constructor(
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    private readonly mistakeRecords: MistakeRecordsService,
  ) {}

  // ------------------------------------------------------------ 建立場次

  async create(userId: string, dto: CreateQuizSessionRequest): Promise<QuizSessionResponse> {
    const { db } = this.database;

    await this.assertScopesExist(userId, dto);
    const candidates = await this.selectCandidates(userId, dto);

    if (candidates.length === 0) {
      throw new AppException(
        ERROR_CODES.QUIZ_NO_QUESTIONS_MATCHED,
        '指定範圍內沒有可作答的題目，請調整條件後再試。',
      );
    }

    const seed = generateSessionSeed();
    const ordered = applyOrderStrategy(candidates, dto.orderStrategy, seed);
    const picked = dto.questionLimit ? ordered.slice(0, dto.questionLimit) : ordered;

    // 一次撈齊所有選項，避免每題一次查詢。
    const optionRows = await db
      .select({
        questionId: schema.questionOptions.questionId,
        key: schema.questionOptions.key,
        isCorrect: schema.questionOptions.isCorrect,
        sortOrder: schema.questionOptions.sortOrder,
      })
      .from(schema.questionOptions)
      .where(
        inArray(
          schema.questionOptions.questionId,
          picked.map((q) => q.id),
        ),
      )
      .orderBy(asc(schema.questionOptions.sortOrder));

    const optionsByQuestion = new Map<string, typeof optionRows>();
    for (const option of optionRows) {
      const list = optionsByQuestion.get(option.questionId) ?? [];
      list.push(option);
      optionsByQuestion.set(option.questionId, list);
    }

    const sessionId = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.quizSessions)
        .values({
          userId,
          mode: dto.mode,
          orderStrategy: dto.orderStrategy,
          shuffleOptions: dto.shuffleOptions,
          questionLimit: dto.questionLimit ?? null,
          revealMode: dto.revealMode,
          allowAnswerChange: dto.allowAnswerChange,
          seed,
          totalQuestions: picked.length,
          configSnapshot: dto,
        })
        .returning({ id: schema.quizSessions.id });

      const id = inserted[0]!.id;

      const scopeValues: (typeof schema.quizSessionScopes.$inferInsert)[] = dto.scopes.map(
        (scope) => ({ sessionId: id, scopeType: scope.scopeType, refId: scope.refId }),
      );
      if (dto.onlyMistakes) {
        scopeValues.push({ sessionId: id, scopeType: 'mistake', refId: null });
      }
      if (scopeValues.length > 0) await tx.insert(schema.quizSessionScopes).values(scopeValues);

      await tx.insert(schema.quizSessionQuestions).values(
        picked.map((question, index) => {
          const options = optionsByQuestion.get(question.id) ?? [];
          const position = index + 1;
          return {
            sessionId: id,
            questionId: question.id,
            position,
            optionOrder: buildOptionOrder(
              options.map((o) => o.key),
              dto.shuffleOptions,
              seed,
              position,
            ),
            questionVersion: question.currentVersion,
            correctAnswersSnapshot: normalizeAnswerKeys(
              options.filter((o) => o.isCorrect).map((o) => o.key),
            ),
          };
        }),
      );

      return id;
    });

    return this.getSession(userId, sessionId);
  }

  /**
   * 範圍必須先驗證存在，才能在使用者打錯 ID 時給出「找不到科目」這種明確訊息。
   * 少了這一步，錯誤的 ID 只會讓查詢結果為空，最後回一個看不出原因的 422。
   */
  private async assertScopesExist(userId: string, dto: CreateQuizSessionRequest): Promise<void> {
    const { db } = this.database;
    const byType = {
      subject: dto.scopes.filter((s) => s.scopeType === 'subject').map((s) => s.refId),
      chapter: dto.scopes.filter((s) => s.scopeType === 'chapter').map((s) => s.refId),
      question_group: dto.scopes
        .filter((s) => s.scopeType === 'question_group')
        .map((s) => s.refId),
      knowledge_tag: dto.scopes
        .filter((s) => s.scopeType === 'knowledge_tag')
        .map((s) => s.refId),
    };

    if (byType.subject.length > 0) {
      const rows = await db
        .select({ id: schema.subjects.id })
        .from(schema.subjects)
        .where(
          and(
            eq(schema.subjects.userId, userId),
            isNull(schema.subjects.deletedAt),
            inArray(schema.subjects.id, byType.subject),
          ),
        );
      if (rows.length !== new Set(byType.subject).size) {
        throw new AppException(ERROR_CODES.SUBJECT_NOT_FOUND, '出題範圍中有不存在的科目。');
      }
    }

    if (byType.chapter.length > 0) {
      const rows = await db
        .select({ id: schema.chapters.id })
        .from(schema.chapters)
        .innerJoin(schema.subjects, eq(schema.subjects.id, schema.chapters.subjectId))
        .where(
          and(
            eq(schema.subjects.userId, userId),
            isNull(schema.chapters.deletedAt),
            inArray(schema.chapters.id, byType.chapter),
          ),
        );
      if (rows.length !== new Set(byType.chapter).size) {
        throw new AppException(ERROR_CODES.CHAPTER_NOT_FOUND, '出題範圍中有不存在的章節。');
      }
    }

    if (byType.question_group.length > 0) {
      const rows = await db
        .select({ id: schema.questionGroups.id })
        .from(schema.questionGroups)
        .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questionGroups.subjectId))
        .where(
          and(
            eq(schema.subjects.userId, userId),
            isNull(schema.questionGroups.deletedAt),
            inArray(schema.questionGroups.id, byType.question_group),
          ),
        );
      if (rows.length !== new Set(byType.question_group).size) {
        throw new AppException(ERROR_CODES.QUESTION_GROUP_NOT_FOUND, '出題範圍中有不存在的題組。');
      }
    }

    if (byType.knowledge_tag.length > 0) {
      const rows = await db
        .select({ id: schema.knowledgeTags.id })
        .from(schema.knowledgeTags)
        .where(
          and(
            eq(schema.knowledgeTags.userId, userId),
            inArray(schema.knowledgeTags.id, byType.knowledge_tag),
          ),
        );
      if (rows.length !== new Set(byType.knowledge_tag).size) {
        throw new AppException(ERROR_CODES.TAG_NOT_FOUND, '出題範圍中有不存在的知識點。');
      }
    }
  }

  /**
   * 解析出題範圍為候選題目。
   *
   * 多個範圍之間取聯集（選了兩個題組就是兩組都出），
   * 「只作答錯題」則是與範圍取交集。
   * 排序一律以題庫的自然順序（科目 → 章節 → 題組 → 題號）輸出，
   * 隨機策略再由 `applyOrderStrategy` 以 seed 打亂，讓 sequential 的結果可預期。
   */
  private async selectCandidates(
    userId: string,
    dto: CreateQuizSessionRequest,
  ): Promise<CandidateQuestion[]> {
    const { db } = this.database;

    const conditions: SQL[] = [
      eq(schema.questions.userId, userId),
      isNull(schema.questions.deletedAt),
      // excluded 是人工標記「這題不要再出現」，disputed 仍可作答（Phase 4 會標記為 provisional）。
      ne(schema.questions.status, 'excluded'),
    ];

    const scopeConditions: SQL[] = [];
    const subjectIds = dto.scopes.filter((s) => s.scopeType === 'subject').map((s) => s.refId);
    const chapterIds = dto.scopes.filter((s) => s.scopeType === 'chapter').map((s) => s.refId);
    const groupIds = dto.scopes
      .filter((s) => s.scopeType === 'question_group')
      .map((s) => s.refId);
    const knowledgeTagIds = dto.scopes
      .filter((s) => s.scopeType === 'knowledge_tag')
      .map((s) => s.refId);

    if (subjectIds.length > 0)
      scopeConditions.push(inArray(schema.questions.subjectId, subjectIds));
    if (chapterIds.length > 0) scopeConditions.push(inArray(schema.questions.chapterId, chapterIds));
    if (groupIds.length > 0)
      scopeConditions.push(inArray(schema.questions.questionGroupId, groupIds));
    if (knowledgeTagIds.length > 0) {
      // 只作答特定知識點（FR-QUIZ-06）。
      // 子查詢的欄位一律寫死資料表名稱限定，理由見 docs/ARCHITECTURE.md 的相關子查詢陷阱。
      scopeConditions.push(
        sql`exists (select 1 from question_knowledge_tags qkt
             where qkt.question_id = questions.id
               and qkt.knowledge_tag_id in ${knowledgeTagIds})`,
      );
    }
    if (scopeConditions.length > 0) conditions.push(or(...scopeConditions)!);

    if (dto.onlyMistakes) {
      const mistakeConditions: SQL[] = [eq(schema.mistakeRecords.userId, userId)];
      if (dto.masteryStates.length > 0) {
        mistakeConditions.push(inArray(schema.mistakeRecords.masteryState, dto.masteryStates));
      }
      const mistakes = await db
        .select({ questionId: schema.mistakeRecords.questionId })
        .from(schema.mistakeRecords)
        .where(and(...mistakeConditions));

      if (mistakes.length === 0) return [];
      conditions.push(
        inArray(
          schema.questions.id,
          mistakes.map((m) => m.questionId),
        ),
      );
    }

    return db
      .select({
        id: schema.questions.id,
        currentVersion: schema.questions.currentVersion,
      })
      .from(schema.questions)
      .innerJoin(
        schema.questionGroups,
        eq(schema.questionGroups.id, schema.questions.questionGroupId),
      )
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questions.subjectId))
      .leftJoin(schema.chapters, eq(schema.chapters.id, schema.questions.chapterId))
      .where(and(...conditions))
      .orderBy(
        asc(schema.subjects.sortOrder),
        asc(schema.subjects.name),
        // 沒有章節的題組直接掛在科目下，排在有章節的前面。
        sql`${schema.chapters.sortOrder} asc nulls first`,
        asc(schema.questionGroups.sortOrder),
        asc(schema.questions.questionNumber),
        asc(schema.questions.id),
      );
  }

  // ------------------------------------------------------------ 讀取

  async list(
    userId: string,
    query: ListQuizSessionsQuery,
  ): Promise<{ items: QuizSessionResponse[]; pagination: PaginationMeta }> {
    const { db } = this.database;
    const conditions: SQL[] = [eq(schema.quizSessions.userId, userId)];
    if (query.status) conditions.push(eq(schema.quizSessions.status, query.status));
    if (query.mode) conditions.push(eq(schema.quizSessions.mode, query.mode));
    const where = and(...conditions);

    const totalRows = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.quizSessions)
      .where(where);
    const total = totalRows[0]?.total ?? 0;

    const rows = await db
      .select()
      .from(schema.quizSessions)
      .where(where)
      .orderBy(desc(schema.quizSessions.startedAt), desc(schema.quizSessions.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      items: await this.hydrateSessions(rows),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  }

  async getSession(userId: string, sessionId: string): Promise<QuizSessionResponse> {
    const row = await this.loadSessionRow(userId, sessionId);
    const [hydrated] = await this.hydrateSessions([row]);
    return hydrated!;
  }

  /**
   * 取得作答中的單題。
   *
   * 選項依 `option_order` 排列且**不含 isCorrect**；
   * 任何答案資訊只會出現在 `reveal`，且由 `resolveReveal()` 集中判斷是否放行。
   */
  async getQuestionAt(
    userId: string,
    sessionId: string,
    position: number,
  ): Promise<QuizQuestionResponse> {
    const { db } = this.database;
    const session = await this.loadSessionRow(userId, sessionId);

    const rows = await db
      .select({
        sessionQuestion: schema.quizSessionQuestions,
        question: schema.questions,
        groupName: schema.questionGroups.name,
        subjectName: schema.subjects.name,
        chapterName: schema.chapters.name,
      })
      .from(schema.quizSessionQuestions)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.quizSessionQuestions.questionId))
      .innerJoin(
        schema.questionGroups,
        eq(schema.questionGroups.id, schema.questions.questionGroupId),
      )
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questions.subjectId))
      .leftJoin(schema.chapters, eq(schema.chapters.id, schema.questions.chapterId))
      .where(
        and(
          eq(schema.quizSessionQuestions.sessionId, sessionId),
          eq(schema.quizSessionQuestions.position, position),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new AppException(ERROR_CODES.NOT_FOUND, `此場次沒有第 ${position} 題。`);
    }

    const options = await db
      .select({
        key: schema.questionOptions.key,
        text: schema.questionOptions.text,
      })
      .from(schema.questionOptions)
      .where(eq(schema.questionOptions.questionId, row.question.id));

    const optionMap = new Map(options.map((o) => [o.key, o]));
    // option_order 是唯一的顯示順序來源；找不到的 key（題目在出題後被改動）直接略過。
    const orderedOptions = row.sessionQuestion.optionOrder
      .map((key) => optionMap.get(key))
      .filter((option): option is (typeof options)[number] => option !== undefined);

    const answerRows = await db
      .select()
      .from(schema.userAnswers)
      .where(eq(schema.userAnswers.sessionQuestionId, row.sessionQuestion.id))
      .orderBy(desc(schema.userAnswers.attemptNumber))
      .limit(1);
    const answer = answerRows[0];

    return {
      sessionQuestionId: row.sessionQuestion.id,
      questionId: row.question.id,
      position: row.sessionQuestion.position,
      totalQuestions: session.totalQuestions,
      status: row.sessionQuestion.status as QuizQuestionResponse['status'],
      questionNumber: row.question.questionNumber,
      type: row.question.type,
      stem: row.question.stem,
      options: orderedOptions.map((o) => ({ key: o.key, text: o.text })),
      subjectName: row.subjectName,
      chapterName: row.chapterName,
      questionGroupName: row.groupName,
      answer: answer
        ? {
            answerId: answer.id,
            selectedAnswers: answer.selectedAnswers,
            responseTimeMs: answer.responseTimeMs,
            answerChangedCount: answer.answerChangedCount,
            answeredAt: answer.answeredAt.toISOString(),
          }
        : null,
      reveal: this.resolveReveal(session, {
        hasAnswer: answer !== undefined,
        isCorrect: answer?.isCorrect ?? false,
        correctAnswers: row.sessionQuestion.correctAnswersSnapshot,
        explanation: row.question.explanation,
        isProvisional: answer?.isProvisional ?? row.question.status === 'disputed',
      }),
    };
  }

  /**
   * 決定是否揭露答案 —— **整個作答流程唯一產生 `reveal` 的地方**。
   *
   * | revealMode | 交卷前 | 交卷後 |
   * |---|---|---|
   * | `immediate` | 已作答才揭露 | 全部揭露 |
   * | `after_submit` | **一律不揭露** | 全部揭露 |
   *
   * 這是契約層的保證（FR-QUIZ-11），不是前端隱藏。
   */
  private resolveReveal(
    session: SessionRow,
    input: {
      hasAnswer: boolean;
      isCorrect: boolean;
      correctAnswers: string[];
      explanation: string | null;
      /** 這次作答是否為暫記（題目答案爭議待審）。 */
      isProvisional: boolean;
    },
  ): QuizReveal | null {
    if (!this.canReveal(session, input.hasAnswer)) return null;

    return {
      isCorrect: input.isCorrect,
      correctAnswers: input.correctAnswers,
      explanation: input.explanation,
      isProvisional: input.isProvisional,
    };
  }

  /**
   * 「這一題現在可以揭露答案了嗎」——揭露規則的單一判準。
   *
   * 抽成獨立方法是因為題目導覽列也要問同一個問題（哪些題可以標對錯）。
   * 判準各寫一份遲早會分岔，而這裡分岔的後果是交卷前洩漏答案。
   * 本專案已經在統計層吃過同型的虧：診斷判準散落兩處，
   * 導致儀表板與錯題頁的數字對不起來。
   */
  private canReveal(session: SessionRow, hasAnswer: boolean): boolean {
    const finished = session.status !== 'in_progress';
    return finished || (session.revealMode === 'immediate' && hasAnswer);
  }

  /**
   * 場次題目導覽：一次取回所有題目的位置與作答狀態，供跳題選單使用。
   *
   * **不回傳選項與正確答案**，只回傳「這題答了沒」以及
   * 在揭露條件成立時才有值的 `isCorrect`。after_submit 模式交卷前
   * 每一題的 `isCorrect` 都是 null——否則使用者只要打開導覽列，
   * 就能看到自己每一題對錯，等同繞過 FR-QUIZ-11。
   */
  async getOutline(userId: string, sessionId: string): Promise<QuizOutlineResponse> {
    const session = await this.loadSessionRow(userId, sessionId);
    const db = this.database.db;

    const rows = await db
      .select({
        sessionQuestionId: schema.quizSessionQuestions.id,
        questionId: schema.questions.id,
        position: schema.quizSessionQuestions.position,
        questionNumber: schema.questions.questionNumber,
        type: schema.questions.type,
        stem: schema.questions.stem,
        answerId: schema.userAnswers.id,
        isCorrect: schema.userAnswers.isCorrect,
        isProvisional: schema.userAnswers.isProvisional,
      })
      .from(schema.quizSessionQuestions)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.quizSessionQuestions.questionId))
      // 一題可能有多次作答（修改答案），只取最新那次——與單題端點同樣以
      // attempt_number 最大者為準。用 LEFT JOIN 加相關子查詢而不是 DISTINCT ON，
      // 是為了讓沒作答的題目仍然出現在清單裡。
      .leftJoin(
        schema.userAnswers,
        and(
          eq(schema.userAnswers.sessionQuestionId, schema.quizSessionQuestions.id),
          sql`user_answers.attempt_number = (
            select max(ua.attempt_number) from user_answers ua
            where ua.session_question_id = quiz_session_questions.id
          )`,
        ),
      )
      .where(eq(schema.quizSessionQuestions.sessionId, sessionId))
      .orderBy(schema.quizSessionQuestions.position);

    return {
      totalQuestions: session.totalQuestions,
      items: rows.map((row) => {
        const hasAnswer = row.answerId !== null;
        return {
          sessionQuestionId: row.sessionQuestionId,
          questionId: row.questionId,
          position: row.position,
          questionNumber: row.questionNumber,
          type: row.type,
          // 只給預覽長度，導覽列不是拿來讀題的。
          stemPreview: row.stem.slice(0, OUTLINE_STEM_PREVIEW_CHARS),
          answered: hasAnswer,
          isCorrect: this.canReveal(session, hasAnswer) ? (row.isCorrect ?? null) : null,
          isProvisional: row.isProvisional ?? false,
        };
      }),
    };
  }

  // ------------------------------------------------------------ 作答

  async answer(
    userId: string,
    sessionId: string,
    dto: SubmitAnswerRequest,
  ): Promise<SubmitAnswerResponse> {
    const session = await this.loadSessionRow(userId, sessionId);
    this.assertInProgress(session);

    const target = await this.loadSessionQuestion(sessionId, dto.sessionQuestionId);
    const existing = await this.loadLatestAnswer(target.sessionQuestion.id);

    // 對同一題再次 POST 視為修改答案，走同一套 allowAnswerChange 規則。
    // 使用者按下「上一題」再改選，前端不必判斷該用 POST 還是 PATCH。
    if (existing && !session.allowAnswerChange) {
      throw new AppException(
        ERROR_CODES.QUIZ_ANSWER_CHANGE_NOT_ALLOWED,
        '此場次不允許修改已作答的答案。',
      );
    }

    return this.writeAnswer(userId, session, target, dto.selectedAnswers, dto.responseTimeMs, existing);
  }

  async updateAnswer(
    userId: string,
    sessionId: string,
    answerId: string,
    dto: UpdateAnswerRequest,
  ): Promise<SubmitAnswerResponse> {
    const session = await this.loadSessionRow(userId, sessionId);
    this.assertInProgress(session);

    if (!session.allowAnswerChange) {
      throw new AppException(
        ERROR_CODES.QUIZ_ANSWER_CHANGE_NOT_ALLOWED,
        '此場次不允許修改已作答的答案。',
      );
    }

    const rows = await this.database.db
      .select()
      .from(schema.userAnswers)
      .where(and(eq(schema.userAnswers.id, answerId), eq(schema.userAnswers.sessionId, sessionId)))
      .limit(1);
    const existing = rows[0];
    if (!existing) throw new AppException(ERROR_CODES.NOT_FOUND, '找不到指定的作答紀錄。');

    const target = await this.loadSessionQuestion(sessionId, existing.sessionQuestionId);
    return this.writeAnswer(
      userId,
      session,
      target,
      dto.selectedAnswers,
      dto.responseTimeMs,
      existing,
    );
  }

  /** 寫入或更新一筆作答並重算統計。判分完全由 `gradeAnswer()` 完成，不呼叫任何 AI（FR-QUIZ-10）。 */
  private async writeAnswer(
    userId: string,
    session: SessionRow,
    target: Awaited<ReturnType<QuizSessionsService['loadSessionQuestion']>>,
    selectedAnswers: string[],
    responseTimeMs: number | null | undefined,
    existing: typeof schema.userAnswers.$inferSelect | undefined,
  ): Promise<SubmitAnswerResponse> {
    const selected = normalizeAnswerKeys(selectedAnswers);
    this.assertSelectionValid(target, selected);

    const isCorrect = gradeAnswer(selected, target.sessionQuestion.correctAnswersSnapshot);
    const now = new Date();

    const answerId = await this.database.db.transaction(async (tx) => {
      let id: string;

      if (existing) {
        await tx
          .update(schema.userAnswers)
          .set({
            selectedAnswers: selected,
            isCorrect,
            responseTimeMs: responseTimeMs ?? existing.responseTimeMs,
            answerChangedCount: existing.answerChangedCount + 1,
            answeredAt: now,
            updatedAt: now,
          })
          .where(eq(schema.userAnswers.id, existing.id));
        id = existing.id;
      } else {
        const inserted = await tx
          .insert(schema.userAnswers)
          .values({
            sessionId: session.id,
            sessionQuestionId: target.sessionQuestion.id,
            questionId: target.sessionQuestion.questionId,
            userId,
            selectedAnswers: selected,
            correctAnswersSnapshot: target.sessionQuestion.correctAnswersSnapshot,
            isCorrect,
            responseTimeMs: responseTimeMs ?? null,
            revealMode: session.revealMode,
            questionVersion: target.sessionQuestion.questionVersion,
            answeredAt: now,
            // 爭議題待審期間的作答只是暫記，不計入能力診斷（FR-QUIZ-14、驗收 #18）。
            // 統計查詢從 Phase 2 起就已經在過濾這個欄位，這裡只負責把值設對。
            isProvisional: target.questionStatus === 'disputed',
          })
          .returning({ id: schema.userAnswers.id });
        id = inserted[0]!.id;

        await tx
          .update(schema.quizSessionQuestions)
          .set({ status: 'answered' })
          .where(eq(schema.quizSessionQuestions.id, target.sessionQuestion.id));
      }

      await this.refreshSessionCounters(tx, session.id);
      await this.mistakeRecords.recompute(tx, userId, target.sessionQuestion.questionId);
      return id;
    });

    const counters = await this.loadSessionRow(userId, session.id);

    return {
      answerId,
      recorded: true,
      answeredCount: counters.answeredCount,
      totalQuestions: counters.totalQuestions,
      reveal: this.resolveReveal(session, {
        hasAnswer: true,
        isCorrect,
        correctAnswers: target.sessionQuestion.correctAnswersSnapshot,
        explanation: target.explanation,
        isProvisional: target.questionStatus === 'disputed',
      }),
    };
  }

  /** 所選代號必須都是本題的選項；單選題只能選一個。 */
  private assertSelectionValid(
    target: Awaited<ReturnType<QuizSessionsService['loadSessionQuestion']>>,
    selected: string[],
  ): void {
    const validKeys = new Set(target.sessionQuestion.optionOrder);
    const unknown = selected.filter((key) => !validKeys.has(key));
    if (unknown.length > 0) {
      throw new AppException(
        ERROR_CODES.VALIDATION_FAILED,
        `選項代號 ${unknown.join('、')} 不屬於這一題。`,
      );
    }
    if (target.type === 'single_choice' && selected.length > 1) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, '單選題只能選擇一個選項。');
    }
  }

  // ------------------------------------------------------------ 交卷與結果

  async submit(userId: string, sessionId: string): Promise<QuizResultResponse> {
    const session = await this.loadSessionRow(userId, sessionId);
    this.assertInProgress(session);

    const now = new Date();
    await this.database.db.transaction(async (tx) => {
      const counters = await this.refreshSessionCounters(tx, sessionId);
      const score =
        session.totalQuestions === 0
          ? 0
          : Math.round((counters.correctCount / session.totalQuestions) * 10000) / 100;

      await tx
        .update(schema.quizSessions)
        .set({
          status: 'submitted',
          submittedAt: now,
          durationMs: now.getTime() - session.startedAt.getTime(),
          score: score.toFixed(2),
          updatedAt: now,
        })
        .where(eq(schema.quizSessions.id, sessionId));

      // 未作答的題目在交卷時標記為 skipped，結果頁才能區分「答錯」與「沒作答」。
      await tx
        .update(schema.quizSessionQuestions)
        .set({ status: 'skipped' })
        .where(
          and(
            eq(schema.quizSessionQuestions.sessionId, sessionId),
            eq(schema.quizSessionQuestions.status, 'unanswered'),
          ),
        );
    });

    return this.getResult(userId, sessionId);
  }

  async abandon(userId: string, sessionId: string): Promise<QuizSessionResponse> {
    const session = await this.loadSessionRow(userId, sessionId);
    this.assertInProgress(session);

    const now = new Date();
    await this.database.db
      .update(schema.quizSessions)
      .set({
        status: 'abandoned',
        durationMs: now.getTime() - session.startedAt.getTime(),
        updatedAt: now,
      })
      .where(eq(schema.quizSessions.id, sessionId));

    return this.getSession(userId, sessionId);
  }

  async getResult(userId: string, sessionId: string): Promise<QuizResultResponse> {
    const { db } = this.database;
    const session = await this.loadSessionRow(userId, sessionId);

    // 交卷前索取結果等同於索取答案，after_submit 模式必須擋下（FR-QUIZ-11）。
    if (session.status === 'in_progress' && session.revealMode === 'after_submit') {
      throw new AppException(
        ERROR_CODES.QUIZ_ANSWER_NOT_REVEALED_YET,
        '此場次設定為交卷後才顯示答案，請先交卷。',
      );
    }

    const rows = await db
      .select({
        sessionQuestion: schema.quizSessionQuestions,
        question: schema.questions,
        groupName: schema.questionGroups.name,
        subjectName: schema.subjects.name,
        chapterName: schema.chapters.name,
      })
      .from(schema.quizSessionQuestions)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.quizSessionQuestions.questionId))
      .innerJoin(
        schema.questionGroups,
        eq(schema.questionGroups.id, schema.questions.questionGroupId),
      )
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questions.subjectId))
      .leftJoin(schema.chapters, eq(schema.chapters.id, schema.questions.chapterId))
      .where(eq(schema.quizSessionQuestions.sessionId, sessionId))
      .orderBy(asc(schema.quizSessionQuestions.position));

    const questionIds = rows.map((row) => row.question.id);
    const options =
      questionIds.length === 0
        ? []
        : await db
            .select()
            .from(schema.questionOptions)
            .where(inArray(schema.questionOptions.questionId, questionIds))
            .orderBy(asc(schema.questionOptions.sortOrder));

    const optionsByQuestion = new Map<string, typeof options>();
    for (const option of options) {
      const list = optionsByQuestion.get(option.questionId) ?? [];
      list.push(option);
      optionsByQuestion.set(option.questionId, list);
    }

    const answers = await db
      .select()
      .from(schema.userAnswers)
      .where(eq(schema.userAnswers.sessionId, sessionId));
    const answerByQuestion = new Map(answers.map((a) => [a.sessionQuestionId, a]));

    const finished = session.status !== 'in_progress';

    const items = rows.map((row) => {
      const answer = answerByQuestion.get(row.sessionQuestion.id);

      // 交卷後全部揭曉；還在作答中的話，只揭曉「這一題已經作答過」的。
      //
      // after_submit 模式在上面就整個擋掉了，所以這裡處理的是 immediate 模式：
      // 即答的承諾是「答完這題就看得到這題的答案」，不是「看得到整份考卷的答案」。
      // 少了這道判斷，作答到一半呼叫 /result 就能一次拿到所有還沒作答題目的答案。
      const revealed = finished || answer !== undefined;

      return {
        position: row.sessionQuestion.position,
        sessionQuestionId: row.sessionQuestion.id,
        questionId: row.question.id,
        questionNumber: row.question.questionNumber,
        type: row.question.type,
        stem: row.question.stem,
        options: (optionsByQuestion.get(row.question.id) ?? []).map((o) => ({
          key: o.key,
          text: o.text,
          isCorrect: revealed ? o.isCorrect : null,
        })),
        selectedAnswers: answer?.selectedAnswers ?? null,
        answerId: answer?.id ?? null,
        correctAnswers: revealed ? row.sessionQuestion.correctAnswersSnapshot : null,
        isCorrect: answer?.isCorrect ?? null,
        explanation: revealed ? row.question.explanation : null,
        responseTimeMs: answer?.responseTimeMs ?? null,
        subjectName: row.subjectName,
        chapterName: row.chapterName,
        questionGroupName: row.groupName,
      };
    });

    const answeredCount = answers.length;
    const correctCount = answers.filter((a) => a.isCorrect).length;
    const times = answers
      .map((a) => a.responseTimeMs)
      .filter((value): value is number => value !== null);

    const [hydratedSession] = await this.hydrateSessions([session]);

    return {
      session: hydratedSession!,
      totalQuestions: session.totalQuestions,
      answeredCount,
      correctCount,
      incorrectCount: answeredCount - correctCount,
      unansweredCount: session.totalQuestions - answeredCount,
      // 未作答視同答錯：分數要反映「這份試卷的表現」，而不是只算做過的題目。
      score:
        session.totalQuestions === 0
          ? 0
          : Math.round((correctCount / session.totalQuestions) * 10000) / 100,
      accuracy:
        answeredCount === 0 ? 0 : Math.round((correctCount / answeredCount) * 10000) / 100,
      durationMs: session.durationMs,
      averageResponseTimeMs:
        times.length === 0
          ? null
          : Math.round(times.reduce((sum, value) => sum + value, 0) / times.length),
      items,
    };
  }

  // ------------------------------------------------------------ helpers

  private async loadSessionRow(userId: string, sessionId: string): Promise<SessionRow> {
    const rows = await this.database.db
      .select()
      .from(schema.quizSessions)
      .where(and(eq(schema.quizSessions.id, sessionId), eq(schema.quizSessions.userId, userId)))
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppException(ERROR_CODES.QUIZ_SESSION_NOT_FOUND, '找不到指定的作答場次。');
    return row;
  }

  private assertInProgress(session: SessionRow): void {
    if (session.status !== 'in_progress') {
      throw new AppException(
        ERROR_CODES.QUIZ_SESSION_ALREADY_SUBMITTED,
        session.status === 'submitted' ? '此場次已交卷。' : '此場次已放棄。',
      );
    }
  }

  private async loadSessionQuestion(
    sessionId: string,
    sessionQuestionId: string,
  ): Promise<{
    sessionQuestion: typeof schema.quizSessionQuestions.$inferSelect;
    type: 'single_choice' | 'multiple_choice';
    explanation: string | null;
    questionStatus: string;
  }> {
    const rows = await this.database.db
      .select({
        sessionQuestion: schema.quizSessionQuestions,
        type: schema.questions.type,
        explanation: schema.questions.explanation,
        questionStatus: schema.questions.status,
      })
      .from(schema.quizSessionQuestions)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.quizSessionQuestions.questionId))
      .where(
        and(
          eq(schema.quizSessionQuestions.id, sessionQuestionId),
          eq(schema.quizSessionQuestions.sessionId, sessionId),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) throw new AppException(ERROR_CODES.NOT_FOUND, '這一題不屬於指定的作答場次。');
    return row;
  }

  private async loadLatestAnswer(
    sessionQuestionId: string,
  ): Promise<typeof schema.userAnswers.$inferSelect | undefined> {
    const rows = await this.database.db
      .select()
      .from(schema.userAnswers)
      .where(eq(schema.userAnswers.sessionQuestionId, sessionQuestionId))
      .orderBy(desc(schema.userAnswers.attemptNumber))
      .limit(1);
    return rows[0];
  }

  /** 由作答紀錄重算場次計數，避免累加式更新在改答案時失準。 */
  private async refreshSessionCounters(
    tx: Database,
    sessionId: string,
  ): Promise<{ answeredCount: number; correctCount: number }> {
    const rows = await tx
      .select({
        answeredCount: sql<number>`count(*)::int`,
        correctCount: sql<number>`count(*) filter (where ${schema.userAnswers.isCorrect})::int`,
      })
      .from(schema.userAnswers)
      .where(eq(schema.userAnswers.sessionId, sessionId));

    const counters = rows[0] ?? { answeredCount: 0, correctCount: 0 };
    await tx
      .update(schema.quizSessions)
      .set({ ...counters, updatedAt: new Date() })
      .where(eq(schema.quizSessions.id, sessionId));
    return counters;
  }

  private async hydrateSessions(rows: SessionRow[]): Promise<QuizSessionResponse[]> {
    if (rows.length === 0) return [];

    const scopes = await this.database.db
      .select()
      .from(schema.quizSessionScopes)
      .where(
        inArray(
          schema.quizSessionScopes.sessionId,
          rows.map((row) => row.id),
        ),
      );

    const refNames = await this.loadScopeNames(scopes);
    const scopesBySession = new Map<string, typeof scopes>();
    for (const scope of scopes) {
      const list = scopesBySession.get(scope.sessionId) ?? [];
      list.push(scope);
      scopesBySession.set(scope.sessionId, list);
    }

    return rows.map((row) => {
      const finished = row.status !== 'in_progress';
      return {
        id: row.id,
        mode: row.mode as QuizSessionResponse['mode'],
        orderStrategy: row.orderStrategy as QuizSessionResponse['orderStrategy'],
        shuffleOptions: row.shuffleOptions,
        questionLimit: row.questionLimit,
        revealMode: row.revealMode,
        allowAnswerChange: row.allowAnswerChange,
        status: row.status as QuizSessionResponse['status'],
        totalQuestions: row.totalQuestions,
        answeredCount: row.answeredCount,
        // after_submit 模式在交卷前不得回傳答對題數：那個數字本身就是答案的洩漏管道。
        correctCount: finished || row.revealMode === 'immediate' ? row.correctCount : null,
        score: row.score === null ? null : Number(row.score),
        scopes: (scopesBySession.get(row.id) ?? []).map((scope) => ({
          scopeType: scope.scopeType as QuizSessionResponse['scopes'][number]['scopeType'],
          refId: scope.refId,
          refName: scope.refId === null ? null : (refNames.get(scope.refId) ?? null),
        })),
        startedAt: row.startedAt.toISOString(),
        submittedAt: row.submittedAt?.toISOString() ?? null,
        durationMs: row.durationMs,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  /** 把範圍的 refId 轉成可顯示的名稱（科目／章節／題組共用一張對照表）。 */
  private async loadScopeNames(
    scopes: (typeof schema.quizSessionScopes.$inferSelect)[],
  ): Promise<Map<string, string>> {
    const { db } = this.database;
    const names = new Map<string, string>();
    const idsOf = (type: string) =>
      scopes.filter((s) => s.scopeType === type && s.refId).map((s) => s.refId!);

    const subjectIds = idsOf('subject');
    const chapterIds = idsOf('chapter');
    const groupIds = idsOf('question_group');
    const knowledgeTagIds = idsOf('knowledge_tag');

    if (knowledgeTagIds.length > 0) {
      const rows = await db
        .select({ id: schema.knowledgeTags.id, name: schema.knowledgeTags.name })
        .from(schema.knowledgeTags)
        .where(inArray(schema.knowledgeTags.id, knowledgeTagIds));
      for (const row of rows) names.set(row.id, row.name);
    }

    if (subjectIds.length > 0) {
      const rows = await db
        .select({ id: schema.subjects.id, name: schema.subjects.name })
        .from(schema.subjects)
        .where(inArray(schema.subjects.id, subjectIds));
      for (const row of rows) names.set(row.id, row.name);
    }
    if (chapterIds.length > 0) {
      const rows = await db
        .select({ id: schema.chapters.id, name: schema.chapters.name })
        .from(schema.chapters)
        .where(inArray(schema.chapters.id, chapterIds));
      for (const row of rows) names.set(row.id, row.name);
    }
    if (groupIds.length > 0) {
      const rows = await db
        .select({ id: schema.questionGroups.id, name: schema.questionGroups.name })
        .from(schema.questionGroups)
        .where(inArray(schema.questionGroups.id, groupIds));
      for (const row of rows) names.set(row.id, row.name);
    }

    return names;
  }
}
