import { schema, type Database } from '@repo/db';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';

/**
 * 計數輔助函式。
 *
 * 為什麼不用相關子查詢（correlated subquery）：
 * Drizzle 在 sql`` 樣板中把 `${schema.subjects.id}` 算繪成「未限定資料表的」`"id"`。
 * 放進子查詢後，`"id"` 會被 PostgreSQL 解析成子查詢自己那張表的 id 欄位，
 * 條件變成 `c.subject_id = c.id` —— 語法完全合法、不會報錯，但結果恆為 0。
 * 這種靜默錯誤比明顯的例外危險得多，因此改用分組聚合後在應用層合併。
 */

export type CountMap = Map<string, number>;

/** 各科目的章節數。 */
export async function countChaptersBySubject(db: Database, subjectIds: string[]): Promise<CountMap> {
  if (subjectIds.length === 0) return new Map();
  const rows = await db
    .select({ key: schema.chapters.subjectId, n: count() })
    .from(schema.chapters)
    .where(and(inArray(schema.chapters.subjectId, subjectIds), isNull(schema.chapters.deletedAt)))
    .groupBy(schema.chapters.subjectId);
  return new Map(rows.map((r) => [r.key, Number(r.n)]));
}

/** 各科目的題組數。 */
export async function countGroupsBySubject(db: Database, subjectIds: string[]): Promise<CountMap> {
  if (subjectIds.length === 0) return new Map();
  const rows = await db
    .select({ key: schema.questionGroups.subjectId, n: count() })
    .from(schema.questionGroups)
    .where(
      and(
        inArray(schema.questionGroups.subjectId, subjectIds),
        isNull(schema.questionGroups.deletedAt),
      ),
    )
    .groupBy(schema.questionGroups.subjectId);
  return new Map(rows.map((r) => [r.key, Number(r.n)]));
}

/** 各科目的題目數。 */
export async function countQuestionsBySubject(
  db: Database,
  subjectIds: string[],
): Promise<CountMap> {
  if (subjectIds.length === 0) return new Map();
  const rows = await db
    .select({ key: schema.questions.subjectId, n: count() })
    .from(schema.questions)
    .where(and(inArray(schema.questions.subjectId, subjectIds), isNull(schema.questions.deletedAt)))
    .groupBy(schema.questions.subjectId);
  return new Map(rows.map((r) => [r.key, Number(r.n)]));
}

/** 各章節的題組數。 */
export async function countGroupsByChapter(db: Database, chapterIds: string[]): Promise<CountMap> {
  if (chapterIds.length === 0) return new Map();
  const rows = await db
    .select({ key: schema.questionGroups.chapterId, n: count() })
    .from(schema.questionGroups)
    .where(
      and(
        inArray(schema.questionGroups.chapterId, chapterIds),
        isNull(schema.questionGroups.deletedAt),
      ),
    )
    .groupBy(schema.questionGroups.chapterId);
  return new Map(rows.filter((r) => r.key !== null).map((r) => [r.key as string, Number(r.n)]));
}

/** 各章節的題目數。 */
export async function countQuestionsByChapter(
  db: Database,
  chapterIds: string[],
): Promise<CountMap> {
  if (chapterIds.length === 0) return new Map();
  const rows = await db
    .select({ key: schema.questions.chapterId, n: count() })
    .from(schema.questions)
    .where(and(inArray(schema.questions.chapterId, chapterIds), isNull(schema.questions.deletedAt)))
    .groupBy(schema.questions.chapterId);
  return new Map(rows.filter((r) => r.key !== null).map((r) => [r.key as string, Number(r.n)]));
}

/** 各題組的題目數。 */
export async function countQuestionsByGroup(db: Database, groupIds: string[]): Promise<CountMap> {
  if (groupIds.length === 0) return new Map();
  const rows = await db
    .select({ key: schema.questions.questionGroupId, n: count() })
    .from(schema.questions)
    .where(
      and(
        inArray(schema.questions.questionGroupId, groupIds),
        isNull(schema.questions.deletedAt),
      ),
    )
    .groupBy(schema.questions.questionGroupId);
  return new Map(rows.map((r) => [r.key, Number(r.n)]));
}

/** 單一題組的題目數（供取單筆時使用）。 */
export async function countQuestionsForGroup(db: Database, groupId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(schema.questions)
    .where(
      and(eq(schema.questions.questionGroupId, groupId), isNull(schema.questions.deletedAt)),
    );
  return Number(rows[0]?.n ?? 0);
}
