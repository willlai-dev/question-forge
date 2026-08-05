import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { IMPORT_ISSUE_CODES } from './types';
import {
  validateImportFile,
  validateImportFiles,
  type ImportValidationContext,
} from './validate';
import { SUPPORTED_SCHEMA_VERSIONS } from './types';

const ctx = (overrides: Partial<ImportValidationContext> = {}): ImportValidationContext => ({
  existingExternalIds: new Set<string>(),
  existingQuestionNumbers: new Set<number>(),
  maxQuestions: 2000,
  ...overrides,
});

const question = (overrides: Record<string, unknown> = {}) => ({
  externalId: 'Q-1',
  questionNumber: 1,
  type: 'single_choice',
  stem: '下列何者屬於行政處分？',
  options: [
    { key: 'A', text: '行政指導' },
    { key: 'B', text: '拆除命令' },
    { key: 'C', text: '行政計畫' },
    { key: 'D', text: '行政契約' },
  ],
  correctAnswers: ['B'],
  explanation: '拆除命令為行政處分。',
  sourcePage: 5,
  sourceReference: '第三章',
  reviewRequired: false,
  reviewReason: null,
  ...overrides,
});

const file = (questions: unknown[], overrides: Record<string, unknown> = {}) => ({
  schemaVersion: '1.0.0',
  subject: { name: '行政法' },
  chapter: { name: '第三章' },
  questionGroup: { name: '112年地特' },
  questions,
  ...overrides,
});

/** 取出某一列的所有錯誤碼。 */
const codesOf = (result: ReturnType<typeof validateImportFile>, row = 0) =>
  result.rows[row]!.issues.map((i) => i.code);

const fileCodes = (result: ReturnType<typeof validateImportFile>) =>
  result.fileIssues.map((i) => i.code);

describe('validateImportFile — 正常路徑', () => {
  it('合法檔案沒有任何 error', () => {
    const result = validateImportFile(file([question()]), ctx());
    expect(result.fileIssues).toHaveLength(0);
    expect(result.errorCount).toBe(0);
    expect(result.validCount).toBe(1);
    expect(result.rows[0]!.hasError).toBe(false);
  });

  it('正確答案被標記在對應選項上', () => {
    const result = validateImportFile(file([question()]), ctx());
    const options = result.rows[0]!.options!;
    expect(options.find((o) => o.key === 'B')!.isCorrect).toBe(true);
    expect(options.filter((o) => o.isCorrect)).toHaveLength(1);
  });

  it('合法的複選題', () => {
    const result = validateImportFile(
      file([question({ type: 'multiple_choice', correctAnswers: ['A', 'C'] })]),
      ctx(),
    );
    expect(result.errorCount).toBe(0);
    expect(result.rows[0]!.options!.filter((o) => o.isCorrect)).toHaveLength(2);
  });
});

describe('檔案層級規則', () => {
  it('不支援的 schemaVersion → error', () => {
    const result = validateImportFile(file([question()], { schemaVersion: '2.0.0' }), ctx());
    expect(fileCodes(result)).toContain(IMPORT_ISSUE_CODES.UNSUPPORTED_SCHEMA_VERSION);
  });

  it('缺少 schemaVersion → error', () => {
    const result = validateImportFile(file([question()], { schemaVersion: undefined }), ctx());
    expect(fileCodes(result)).toContain(IMPORT_ISSUE_CODES.UNSUPPORTED_SCHEMA_VERSION);
  });

  it('最外層是陣列 → error 且不再逐題處理', () => {
    const result = validateImportFile([question()], ctx());
    expect(fileCodes(result)).toContain(IMPORT_ISSUE_CODES.INVALID_FILE_STRUCTURE);
    expect(result.rows).toHaveLength(0);
  });

  it('questions 不是陣列 → error', () => {
    const result = validateImportFile(file([]).constructor === Object ? { ...file([]), questions: 'nope' } : {}, ctx());
    expect(fileCodes(result)).toContain(IMPORT_ISSUE_CODES.INVALID_FILE_STRUCTURE);
  });

  it('questions 為空陣列 → error', () => {
    const result = validateImportFile(file([]), ctx());
    expect(fileCodes(result)).toContain(IMPORT_ISSUE_CODES.INVALID_FILE_STRUCTURE);
  });

  it('缺少 subject.name → error', () => {
    const result = validateImportFile(file([question()], { subject: {} }), ctx());
    expect(fileCodes(result)).toContain(IMPORT_ISSUE_CODES.INVALID_FILE_STRUCTURE);
  });

  it('缺少 questionGroup.name → error', () => {
    const result = validateImportFile(file([question()], { questionGroup: {} }), ctx());
    expect(fileCodes(result)).toContain(IMPORT_ISSUE_CODES.INVALID_FILE_STRUCTURE);
  });

  it('題數超過上限 → error', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      question({ externalId: `Q-${i}`, questionNumber: i + 1 }),
    );
    const result = validateImportFile(file(many), ctx({ maxQuestions: 3 }));
    expect(fileCodes(result)).toContain(IMPORT_ISSUE_CODES.TOO_MANY_QUESTIONS);
  });
});

describe('逐題規則 — 題型與題幹', () => {
  it('不合法的題型 → error', () => {
    const result = validateImportFile(file([question({ type: 'fill_in_blank' })]), ctx());
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.INVALID_QUESTION_TYPE);
  });

  it('題幹為空字串 → error', () => {
    const result = validateImportFile(file([question({ stem: '' })]), ctx());
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.EMPTY_STEM);
  });

  it('題幹只有空白 → error', () => {
    const result = validateImportFile(file([question({ stem: '   ' })]), ctx());
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.EMPTY_STEM);
  });

  it('題幹過長 → warning（不阻擋）', () => {
    const result = validateImportFile(
      file([question({ stem: 'x'.repeat(5000) })]),
      ctx({ stemWarningLength: 100 }),
    );
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.STEM_TOO_LONG);
    expect(result.rows[0]!.hasError).toBe(false);
  });

  it('該筆不是物件 → error', () => {
    const result = validateImportFile(file(['not-an-object']), ctx());
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.INVALID_ROW_SHAPE);
  });
});

describe('逐題規則 — 選項', () => {
  it('只有一個選項 → error', () => {
    const result = validateImportFile(
      file([question({ options: [{ key: 'A', text: '甲' }], correctAnswers: ['A'] })]),
      ctx(),
    );
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.TOO_FEW_OPTIONS);
  });

  it('options 不是陣列 → error', () => {
    const result = validateImportFile(file([question({ options: 'nope' })]), ctx());
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.TOO_FEW_OPTIONS);
  });

  it('選項代號重複 → error', () => {
    const result = validateImportFile(
      file([
        question({
          options: [
            { key: 'A', text: '甲' },
            { key: 'A', text: '乙' },
            { key: 'B', text: '丙' },
          ],
          correctAnswers: ['B'],
        }),
      ]),
      ctx(),
    );
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.DUPLICATE_OPTION_KEY);
  });

  it('選項內容為空 → error', () => {
    const result = validateImportFile(
      file([
        question({
          options: [
            { key: 'A', text: '' },
            { key: 'B', text: '乙' },
          ],
          correctAnswers: ['B'],
        }),
      ]),
      ctx(),
    );
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.EMPTY_OPTION_TEXT);
  });

  it('小寫選項代號 → warning 並自動轉大寫', () => {
    const result = validateImportFile(
      file([
        question({
          options: [
            { key: 'a', text: '甲' },
            { key: 'b', text: '乙' },
          ],
          correctAnswers: ['a'],
        }),
      ]),
      ctx(),
    );
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.OPTION_KEY_NOT_UPPERCASE);
    expect(result.rows[0]!.hasError).toBe(false);
    expect(result.rows[0]!.options!.map((o) => o.key)).toEqual(['A', 'B']);
    expect(result.rows[0]!.options!.find((o) => o.key === 'A')!.isCorrect).toBe(true);
  });
});

describe('逐題規則 — 正確答案', () => {
  it('正確答案不在選項中 → error', () => {
    const result = validateImportFile(file([question({ correctAnswers: ['E'] })]), ctx());
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.CORRECT_ANSWER_NOT_IN_OPTIONS);
  });

  it('沒有正確答案 → error', () => {
    const result = validateImportFile(file([question({ correctAnswers: [] })]), ctx());
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.NO_CORRECT_ANSWER);
  });

  it('correctAnswers 不是陣列 → error', () => {
    const result = validateImportFile(file([question({ correctAnswers: 'B' })]), ctx());
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.NO_CORRECT_ANSWER);
  });

  it('單選題有多個答案 → error', () => {
    const result = validateImportFile(
      file([question({ type: 'single_choice', correctAnswers: ['A', 'B'] })]),
      ctx(),
    );
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.SINGLE_CHOICE_MULTIPLE_ANSWERS);
  });

  it('複選題只有一個答案 → error', () => {
    const result = validateImportFile(
      file([question({ type: 'multiple_choice', correctAnswers: ['A'] })]),
      ctx(),
    );
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.MULTIPLE_CHOICE_TOO_FEW_ANSWERS);
  });

  it('重複的正確答案會去重後再判定數量', () => {
    const result = validateImportFile(
      file([question({ type: 'single_choice', correctAnswers: ['B', 'B'] })]),
      ctx(),
    );
    expect(codesOf(result)).not.toContain(IMPORT_ISSUE_CODES.SINGLE_CHOICE_MULTIPLE_ANSWERS);
  });
});

describe('逐題規則 — 重複偵測', () => {
  it('批次內 externalId 重複 → 兩筆都 error', () => {
    const result = validateImportFile(
      file([question({ externalId: 'DUP', questionNumber: 1 }), question({ externalId: 'DUP', questionNumber: 2 })]),
      ctx(),
    );
    expect(codesOf(result, 0)).toContain(IMPORT_ISSUE_CODES.DUPLICATE_EXTERNAL_ID_IN_BATCH);
    expect(codesOf(result, 1)).toContain(IMPORT_ISSUE_CODES.DUPLICATE_EXTERNAL_ID_IN_BATCH);
  });

  it('與題庫既有 externalId 衝突 → error', () => {
    const result = validateImportFile(
      file([question({ externalId: 'EXISTING' })]),
      ctx({ existingExternalIds: new Set(['EXISTING']) }),
    );
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.DUPLICATE_EXTERNAL_ID_IN_DB);
  });

  it('批次內題號重複 → error', () => {
    const result = validateImportFile(
      file([question({ externalId: 'A', questionNumber: 7 }), question({ externalId: 'B', questionNumber: 7 })]),
      ctx(),
    );
    expect(codesOf(result, 0)).toContain(IMPORT_ISSUE_CODES.DUPLICATE_QUESTION_NUMBER_IN_BATCH);
  });

  it('與目標題組既有題號衝突 → error', () => {
    const result = validateImportFile(
      file([question({ questionNumber: 12 })]),
      ctx({ existingQuestionNumbers: new Set([12]) }),
    );
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.DUPLICATE_QUESTION_NUMBER_IN_DB);
  });

  it('缺少 externalId → 只是 warning', () => {
    const result = validateImportFile(file([question({ externalId: null })]), ctx());
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.MISSING_EXTERNAL_ID);
    expect(result.rows[0]!.hasError).toBe(false);
  });
});

describe('逐題規則 — 題號與頁碼', () => {
  it.each([['abc'], [1.5], [null], [undefined]])('題號為 %s → error', (value) => {
    const result = validateImportFile(file([question({ questionNumber: value })]), ctx());
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.INVALID_QUESTION_NUMBER);
  });

  it('題號為 0 或負數 → error', () => {
    expect(codesOf(validateImportFile(file([question({ questionNumber: 0 })]), ctx()))).toContain(
      IMPORT_ISSUE_CODES.INVALID_QUESTION_NUMBER,
    );
    expect(codesOf(validateImportFile(file([question({ questionNumber: -3 })]), ctx()))).toContain(
      IMPORT_ISSUE_CODES.INVALID_QUESTION_NUMBER,
    );
  });

  it('sourcePage 為 0 → error', () => {
    const result = validateImportFile(file([question({ sourcePage: 0 })]), ctx());
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.INVALID_SOURCE_PAGE);
  });

  it('sourcePage 為 null → 合法', () => {
    const result = validateImportFile(file([question({ sourcePage: null })]), ctx());
    expect(codesOf(result)).not.toContain(IMPORT_ISSUE_CODES.INVALID_SOURCE_PAGE);
    expect(result.rows[0]!.sourcePage).toBeNull();
  });
});

describe('解析缺失與需複核（皆為 warning，不阻擋 commit）', () => {
  it('explanation 為 null → warning，且不得被自動填入內容', () => {
    const result = validateImportFile(file([question({ explanation: null })]), ctx());
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.MISSING_EXPLANATION);
    expect(result.rows[0]!.hasError).toBe(false);
    // 關鍵：系統絕不編造解析
    expect(result.rows[0]!.explanation).toBeNull();
  });

  it('explanation 為空字串 → 同樣視為缺失且保持 null', () => {
    const result = validateImportFile(file([question({ explanation: '   ' })]), ctx());
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.MISSING_EXPLANATION);
    expect(result.rows[0]!.explanation).toBeNull();
  });

  it('reviewRequired 為 true → warning', () => {
    const result = validateImportFile(
      file([question({ reviewRequired: true, reviewReason: '答案模糊' })]),
      ctx(),
    );
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.REVIEW_REQUIRED);
    expect(result.rows[0]!.hasError).toBe(false);
    expect(result.reviewRequiredCount).toBe(1);
  });

  it('標記需複核但沒有原因 → 額外 warning', () => {
    const result = validateImportFile(file([question({ reviewRequired: true })]), ctx());
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.MISSING_REVIEW_REASON);
  });
});

describe('統計數字', () => {
  it('正確區分 error / warning / valid', () => {
    const result = validateImportFile(
      file([
        question({ externalId: 'ok', questionNumber: 1 }),
        question({ externalId: 'warn', questionNumber: 2, explanation: null }),
        question({ externalId: 'err', questionNumber: 3, stem: '' }),
      ]),
      ctx(),
    );
    expect(result.errorCount).toBe(1);
    expect(result.warningCount).toBe(1);
    expect(result.validCount).toBe(2);
  });
});

/**
 * 章節筆記（schemaVersion 1.1.0）。
 *
 * 使用者的單章 PDF 通常題目與筆記並存，筆記匯入後成為該題庫的本地資料源。
 */
describe('章節筆記', () => {
  const noteFile = (notes: unknown, questions: unknown[] = [question()]) =>
    file(questions, { schemaVersion: '1.1.0', notes });

  it('1.0.0 的檔案沒有 notes，照樣通過且 notes 為空陣列', () => {
    const result = validateImportFile(file([question()]), ctx());
    expect(result.fileIssues).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it('1.1.0 仍然是支援的版本', () => {
    const result = validateImportFile(noteFile([]), ctx());
    expect(result.fileIssues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('合法的筆記會被正規化出來', () => {
    const result = validateImportFile(
      noteFile([
        {
          noteId: 'N1',
          title: '各類金融商品交易稅',
          content: '臺指期貨屬股價類期貨，按契約金額課徵十萬分之2。',
          sourcePage: 12,
          keywords: ['期貨交易稅', 'REITs'],
        },
      ]),
      ctx(),
    );
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatchObject({
      noteKey: 'N1',
      title: '各類金融商品交易稅',
      sourcePage: 12,
      keywords: ['期貨交易稅', 'REITs'],
    });
  });

  it('notes 不是陣列 → 檔案層錯誤', () => {
    const result = validateImportFile(noteFile('不是陣列'), ctx());
    expect(result.fileIssues.map((i) => i.code)).toContain(IMPORT_ISSUE_CODES.INVALID_NOTE_SHAPE);
  });

  it('缺少 noteId → 擋下該筆', () => {
    const result = validateImportFile(noteFile([{ content: '有內容但沒有 id' }]), ctx());
    expect(result.fileIssues.map((i) => i.code)).toContain(IMPORT_ISSUE_CODES.INVALID_NOTE_SHAPE);
    expect(result.notes).toHaveLength(0);
  });

  it('noteId 重複 → 擋下', () => {
    const result = validateImportFile(
      noteFile([
        { noteId: 'N1', content: '第一段' },
        { noteId: 'N1', content: '第二段' },
      ]),
      ctx(),
    );
    expect(result.fileIssues.map((i) => i.code)).toContain(IMPORT_ISSUE_CODES.DUPLICATE_NOTE_ID);
    expect(result.notes).toHaveLength(1);
  });

  it('content 為空 → 擋下', () => {
    const result = validateImportFile(noteFile([{ noteId: 'N1', content: '   ' }]), ctx());
    expect(result.fileIssues.map((i) => i.code)).toContain(IMPORT_ISSUE_CODES.EMPTY_NOTE_CONTENT);
  });

  it('content 過長 → 擋下並要求拆分', () => {
    const result = validateImportFile(
      noteFile([{ noteId: 'N1', content: 'x'.repeat(20_001) }]),
      ctx(),
    );
    expect(result.fileIssues.map((i) => i.code)).toContain(
      IMPORT_ISSUE_CODES.NOTE_CONTENT_TOO_LONG,
    );
  });

  it('筆記數量超過上限 → 擋下整批', () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ noteId: `N${i}`, content: '內容' }));
    const result = validateImportFile(noteFile(many), ctx());
    expect(result.fileIssues.map((i) => i.code)).toContain(IMPORT_ISSUE_CODES.TOO_MANY_NOTES);
    expect(result.notes).toHaveLength(0);
  });

  it('題目可以明確關聯筆記', () => {
    const result = validateImportFile(
      noteFile(
        [{ noteId: 'N1', content: '相關筆記' }],
        [question({ relatedNoteIds: ['N1'] })],
      ),
      ctx(),
    );
    expect(result.rows[0]!.relatedNoteIds).toEqual(['N1']);
    expect(result.rows[0]!.hasError).toBe(false);
  });

  it('**引用不存在的 noteId → error 而不是靜靜忽略**', () => {
    // 忽略掉的話，使用者會以為這題掛了筆記，實際上分析時根本沒帶進去
    // —— 那是最難察覺的那種失效。
    const result = validateImportFile(
      noteFile(
        [{ noteId: 'N1', content: '相關筆記' }],
        [question({ relatedNoteIds: ['N1', 'N9'] })],
      ),
      ctx(),
    );
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.UNKNOWN_NOTE_REFERENCE);
    expect(result.rows[0]!.hasError).toBe(true);
  });

  it('重複引用同一段筆記會去重，但不算錯誤', () => {
    const result = validateImportFile(
      noteFile(
        [{ noteId: 'N1', content: '相關筆記' }],
        [question({ relatedNoteIds: ['N1', 'N1'] })],
      ),
      ctx(),
    );
    expect(result.rows[0]!.relatedNoteIds).toEqual(['N1']);
    expect(result.rows[0]!.hasError).toBe(false);
  });

  it('沒有 relatedNoteIds 的題目照常通過', () => {
    const result = validateImportFile(
      noteFile([{ noteId: 'N1', content: '相關筆記' }]),
      ctx(),
    );
    expect(result.rows[0]!.relatedNoteIds).toEqual([]);
    expect(result.rows[0]!.hasError).toBe(false);
  });
});

/**
 * 多題組匯入（schemaVersion 1.2.0 與多檔上傳）。
 *
 * 使用者情境：一次匯入同一科目、不同章節的多份題庫。
 */
describe('多題組', () => {
  const groupFile = (groups: unknown, overrides: Record<string, unknown> = {}) => ({
    schemaVersion: '1.2.0',
    subject: { name: '投資學' },
    questionGroups: groups,
    ...overrides,
  });

  const grp = (name: string, chapter: string | null, questions: unknown[]) => ({
    name,
    ...(chapter ? { chapter: { name: chapter } } : {}),
    questions,
  });

  it('1.2.0 的多題組會被拆成多個題組', () => {
    const result = validateImportFile(
      groupFile([
        grp('第一章練習題', '第一章', [question({ externalId: 'A-1', questionNumber: 1 })]),
        grp('第二章練習題', '第二章', [question({ externalId: 'B-1', questionNumber: 1 })]),
      ]),
      ctx(),
    );
    expect(result.fileIssues.filter((i) => i.level === 'error')).toEqual([]);
    expect(result.groups).toHaveLength(2);
    expect(result.groups.map((g) => g.chapterName)).toEqual(['第一章', '第二章']);
    expect(result.subjectName).toBe('投資學');
  });

  it('**不同題組的題號可以重複**（各自是獨立的題組）', () => {
    // 第一章第 1 題與第二章第 1 題本來就會撞號；題號唯一性只在題組內成立，
    // 資料庫的唯一索引也是那個範圍。
    const result = validateImportFile(
      groupFile([
        grp('第一章', '第一章', [question({ externalId: 'A-1', questionNumber: 1 })]),
        grp('第二章', '第二章', [question({ externalId: 'B-1', questionNumber: 1 })]),
      ]),
      ctx(),
    );
    expect(result.errorCount).toBe(0);
  });

  it('同一題組內題號重複仍然要擋下', () => {
    const result = validateImportFile(
      groupFile([
        grp('第一章', '第一章', [
          question({ externalId: 'A-1', questionNumber: 1 }),
          question({ externalId: 'A-2', questionNumber: 1 }),
        ]),
      ]),
      ctx(),
    );
    expect(result.errorCount).toBe(2);
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.DUPLICATE_QUESTION_NUMBER_IN_BATCH);
  });

  it('**externalId 跨題組仍必須唯一**（它是全域識別）', () => {
    const result = validateImportFile(
      groupFile([
        grp('第一章', '第一章', [question({ externalId: 'SAME', questionNumber: 1 })]),
        grp('第二章', '第二章', [question({ externalId: 'SAME', questionNumber: 1 })]),
      ]),
      ctx(),
    );
    expect(codesOf(result)).toContain(IMPORT_ISSUE_CODES.DUPLICATE_EXTERNAL_ID_IN_BATCH);
  });

  it('**rowIndex 在整個批次內唯一**（資料庫唯一索引是 batchId + rowIndex）', () => {
    const result = validateImportFile(
      groupFile([
        grp('第一章', '第一章', [
          question({ externalId: 'A-1', questionNumber: 1 }),
          question({ externalId: 'A-2', questionNumber: 2 }),
        ]),
        grp('第二章', '第二章', [question({ externalId: 'B-1', questionNumber: 1 })]),
      ]),
      ctx(),
    );
    const indexes = result.rows.map((r) => r.rowIndex);
    expect(indexes).toEqual([0, 1, 2]);
  });

  it('每一列都記得自己屬於哪個題組', () => {
    const result = validateImportFile(
      groupFile([
        grp('第一章', '第一章', [question({ externalId: 'A-1', questionNumber: 1 })]),
        grp('第二章', '第二章', [question({ externalId: 'B-1', questionNumber: 1 })]),
      ]),
      ctx(),
    );
    expect(result.rows.map((r) => r.groupIndex)).toEqual([0, 1]);
  });

  it('題組各自帶自己的章節筆記', () => {
    const result = validateImportFile(
      groupFile([
        {
          name: '第一章',
          chapter: { name: '第一章' },
          notes: [{ noteId: 'N1', content: '第一章的筆記' }],
          questions: [question({ externalId: 'A-1', relatedNoteIds: ['N1'] })],
        },
        {
          name: '第二章',
          chapter: { name: '第二章' },
          questions: [question({ externalId: 'B-1' })],
        },
      ]),
      ctx(),
    );
    expect(result.groups[0]!.studyNotes).toHaveLength(1);
    expect(result.groups[1]!.studyNotes).toHaveLength(0);
    expect(result.errorCount).toBe(0);
  });

  it('**筆記引用不跨題組**：引用別組的 noteId 要擋下', () => {
    const result = validateImportFile(
      groupFile([
        {
          name: '第一章',
          notes: [{ noteId: 'N1', content: '第一章的筆記' }],
          questions: [question({ externalId: 'A-1' })],
        },
        {
          name: '第二章',
          questions: [question({ externalId: 'B-1', relatedNoteIds: ['N1'] })],
        },
      ]),
      ctx(),
    );
    expect(codesOf(result, 1)).toContain(IMPORT_ISSUE_CODES.UNKNOWN_NOTE_REFERENCE);
  });

  it('**題組的 notes 是字串時視為題組備註**（不是章節筆記）', () => {
    // 舊格式把備註放 questionGroup.notes、章節筆記放根層 notes；
    // 1.2.0 兩者同名，只能靠型別分流。
    const result = validateImportFile(
      groupFile([
        { name: '第一章', notes: '這份是考古題', questions: [question({ externalId: 'A-1' })] },
      ]),
      ctx(),
    );
    expect(result.errorCount).toBe(0);
    expect(result.fileIssues.filter((i) => i.level === 'error')).toEqual([]);
    expect(result.groups[0]!.studyNotes).toEqual([]);
    expect(result.groups[0]!.groupNotes).toBe('這份是考古題');
  });

  it('questionGroups 不是陣列 → 檔案層錯誤', () => {
    const result = validateImportFile(groupFile('nope'), ctx());
    expect(result.fileIssues.map((i) => i.code)).toContain(IMPORT_ISSUE_CODES.INVALID_GROUP_SHAPE);
  });

  it('題組數量超過上限 → 擋下', () => {
    const many = Array.from({ length: 51 }, (_, i) =>
      grp(`第 ${i} 章`, null, [question({ externalId: `X-${i}` })]),
    );
    const result = validateImportFile(groupFile(many), ctx());
    expect(result.fileIssues.map((i) => i.code)).toContain(IMPORT_ISSUE_CODES.TOO_MANY_GROUPS);
  });

  it('**1.0.0 的單題組檔案被正規化成一個題組**（下游只有一種形狀）', () => {
    const result = validateImportFile(file([question()]), ctx());
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.groupName).toBe('112年地特');
    expect(result.groups[0]!.chapterName).toBe('第三章');
  });
});

describe('多檔上傳', () => {
  const oneGroupFile = (subject: string, chapter: string, externalId: string) => ({
    schemaVersion: '1.0.0',
    subject: { name: subject },
    chapter: { name: chapter },
    questionGroup: { name: `${chapter}題本` },
    questions: [question({ externalId, questionNumber: 1 })],
  });

  it('多個舊格式檔案合併成多個題組', () => {
    const result = validateImportFiles(
      [
        { filename: 'ch1.json', raw: oneGroupFile('投資學', '第一章', 'A-1') },
        { filename: 'ch2.json', raw: oneGroupFile('投資學', '第二章', 'B-1') },
      ],
      ctx(),
    );
    expect(result.fileIssues.filter((i) => i.level === 'error')).toEqual([]);
    expect(result.groups).toHaveLength(2);
    expect(result.groups.map((g) => g.sourceFilename)).toEqual(['ch1.json', 'ch2.json']);
  });

  it('**各檔科目不一致 → 擋下**（否則這批要匯到哪裡沒有唯一答案）', () => {
    const result = validateImportFiles(
      [
        { filename: 'a.json', raw: oneGroupFile('投資學', '第一章', 'A-1') },
        { filename: 'b.json', raw: oneGroupFile('會計學', '第一章', 'B-1') },
      ],
      ctx(),
    );
    expect(result.fileIssues.map((i) => i.code)).toContain(
      IMPORT_ISSUE_CODES.SUBJECT_MISMATCH_ACROSS_FILES,
    );
  });

  it('錯誤訊息帶得出是哪一個檔案', () => {
    const result = validateImportFiles(
      [
        { filename: 'good.json', raw: oneGroupFile('投資學', '第一章', 'A-1') },
        { filename: 'bad.json', raw: { schemaVersion: '9.9.9', subject: { name: '投資學' } } },
      ],
      ctx(),
    );
    expect(JSON.stringify(result.fileIssues)).toContain('bad.json');
  });

  it('題號在不同檔案之間可以重複', () => {
    const result = validateImportFiles(
      [
        { filename: 'ch1.json', raw: oneGroupFile('投資學', '第一章', 'A-1') },
        { filename: 'ch2.json', raw: oneGroupFile('投資學', '第二章', 'B-1') },
      ],
      ctx(),
    );
    expect(result.errorCount).toBe(0);
  });

  it('空的檔案清單不會爆炸', () => {
    const result = validateImportFiles([], ctx());
    expect(result.groups).toEqual([]);
    expect(result.fileIssues.length).toBeGreaterThan(0);
  });
});

/**
 * 文件與驗證器不能各說各話。
 *
 * `GET /imports/schema` 直接把 docs/QUESTION_IMPORT_SCHEMA.json 回給前端，
 * 使用者照著上面的範例產生 JSON。範例若不被自家驗證器接受，
 * 錯的是我們而不是使用者——所以把文件裡的範例真的跑一遍。
 */
describe('文件範例', () => {
  const docPath = fileURLToPath(new URL('../../../../docs/QUESTION_IMPORT_SCHEMA.json', import.meta.url));
  const doc = JSON.parse(readFileSync(docPath, 'utf-8')) as {
    properties: { schemaVersion: { enum: string[] } };
    examples: unknown[];
  };

  it('文件宣告的版本與程式支援的版本一致', () => {
    expect(doc.properties.schemaVersion.enum).toEqual([...SUPPORTED_SCHEMA_VERSIONS]);
  });

  it.each(doc.examples.map((ex, i) => [i, ex] as const))(
    '範例 %i 通得過驗證',
    (_i, example) => {
      const result = validateImportFile(example, ctx());
      expect(result.fileIssues.filter((issue) => issue.level === 'error')).toEqual([]);
      expect(result.errorCount).toBe(0);
    },
  );
});
