import { describe, expect, it } from 'vitest';

import { IMPORT_ISSUE_CODES } from './types';
import { validateImportFile, type ImportValidationContext } from './validate';

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
