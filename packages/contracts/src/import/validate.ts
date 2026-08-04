import {
  IMPORT_ISSUE_CODES,
  MAX_NOTES_PER_IMPORT,
  NOTE_CONTENT_MAX_CHARS,
  SUPPORTED_SCHEMA_VERSIONS,
  type ImportIssue,
  type ImportIssueCode,
  type ImportIssueLevel,
} from './types';

/**
 * 匯入驗證引擎。
 *
 * 刻意寫成「純函式」：輸入是已解析的 JSON 與一份 context，輸出是問題清單與正規化結果。
 * 不碰資料庫、不碰時間、不碰隨機值 —— 因此 17 條規則可以逐條寫單元測試，
 * 而規格 §18 明令「不得只做 happy path」。
 */

export interface ImportValidationContext {
  /** 已存在於題庫的 externalId（同一使用者範圍）。 */
  existingExternalIds: ReadonlySet<string>;
  /** 目標題組中已存在的題號。 */
  existingQuestionNumbers: ReadonlySet<number>;
  maxQuestions: number;
  /** 題幹超過此長度視為可疑（可能跨頁未合併）。 */
  stemWarningLength?: number;
}

export interface NormalizedOption {
  key: string;
  text: string;
  isCorrect: boolean;
}

export interface NormalizedImportQuestion {
  rowIndex: number;
  externalId: string | null;
  questionNumber: number | null;
  type: 'single_choice' | 'multiple_choice' | null;
  stem: string | null;
  options: NormalizedOption[] | null;
  explanation: string | null;
  sourcePage: number | null;
  sourceReference: string | null;
  reviewRequired: boolean;
  reviewReason: string | null;
  /** 這一題明確關聯的筆記 noteKey（來自檔案的 relatedNoteIds）。 */
  relatedNoteIds: string[];
  issues: ImportIssue[];
  /** 有任何 error 級問題就不可 commit。 */
  hasError: boolean;
}

/** 章節筆記。與題目同批匯入，之後作為該題庫的本地資料源。 */
export interface NormalizedImportNote {
  /** 檔案內的識別（例如 N1），題目用它建立關聯。 */
  noteKey: string;
  title: string | null;
  content: string;
  sourcePage: number | null;
  keywords: string[];
}

export interface ImportValidationResult {
  fileIssues: ImportIssue[];
  rows: NormalizedImportQuestion[];
  /** 通過驗證的筆記。檔案沒有 notes 時為空陣列。 */
  notes: NormalizedImportNote[];
  errorCount: number;
  warningCount: number;
  validCount: number;
  reviewRequiredCount: number;
}

const DEFAULT_STEM_WARNING_LENGTH = 3000;

function issue(
  level: ImportIssueLevel,
  code: ImportIssueCode,
  message: string,
  rowIndex: number | null,
  fieldPath?: string,
): ImportIssue {
  return { level, code, message, rowIndex, ...(fieldPath ? { fieldPath } : {}) };
}

const asString = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

const asInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) ? v : null;

/** 驗證整份匯入檔。 */
export function validateImportFile(
  raw: unknown,
  context: ImportValidationContext,
): ImportValidationResult {
  const fileIssues: ImportIssue[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fileIssues.push(
      issue('error', IMPORT_ISSUE_CODES.INVALID_FILE_STRUCTURE, '檔案最外層必須是一個 JSON 物件。', null),
    );
    return emptyResult(fileIssues);
  }

  const file = raw as Record<string, unknown>;

  // --- 規則 1：schemaVersion 是否支援 ---
  const schemaVersion = asString(file.schemaVersion);
  if (!schemaVersion) {
    fileIssues.push(
      issue('error', IMPORT_ISSUE_CODES.UNSUPPORTED_SCHEMA_VERSION, '缺少 schemaVersion 欄位。', null, 'schemaVersion'),
    );
  } else if (!(SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(schemaVersion)) {
    fileIssues.push(
      issue(
        'error',
        IMPORT_ISSUE_CODES.UNSUPPORTED_SCHEMA_VERSION,
        `不支援的 schemaVersion「${schemaVersion}」，目前僅支援：${SUPPORTED_SCHEMA_VERSIONS.join('、')}。`,
        null,
        'schemaVersion',
      ),
    );
  }

  // --- 檔案結構：科目與題組名稱 ---
  const subject = file.subject as Record<string, unknown> | undefined;
  if (!subject || !asString(subject.name)) {
    fileIssues.push(
      issue('error', IMPORT_ISSUE_CODES.INVALID_FILE_STRUCTURE, 'subject.name 為必填。', null, 'subject.name'),
    );
  }

  const questionGroup = file.questionGroup as Record<string, unknown> | undefined;
  if (!questionGroup || !asString(questionGroup.name)) {
    fileIssues.push(
      issue('error', IMPORT_ISSUE_CODES.INVALID_FILE_STRUCTURE, 'questionGroup.name 為必填。', null, 'questionGroup.name'),
    );
  }

  if (!Array.isArray(file.questions)) {
    fileIssues.push(
      issue('error', IMPORT_ISSUE_CODES.INVALID_FILE_STRUCTURE, 'questions 必須是陣列。', null, 'questions'),
    );
    return emptyResult(fileIssues);
  }

  const rawQuestions = file.questions;

  // --- 規則：題數上限 ---
  if (rawQuestions.length > context.maxQuestions) {
    fileIssues.push(
      issue(
        'error',
        IMPORT_ISSUE_CODES.TOO_MANY_QUESTIONS,
        `題目數量 ${rawQuestions.length} 超過單次匯入上限 ${context.maxQuestions}。`,
        null,
        'questions',
      ),
    );
  }

  if (rawQuestions.length === 0) {
    fileIssues.push(
      issue('error', IMPORT_ISSUE_CODES.INVALID_FILE_STRUCTURE, 'questions 不可為空陣列。', null, 'questions'),
    );
  }

  // --- 筆記（1.1.0）---
  //
  // 必須在逐題驗證**之前**處理：題目的 relatedNoteIds 要比對已知的 noteKey，
  // 順序反了就無法判斷引用是否對得上。
  const { notes, issues: noteIssues } = validateNotes(file.notes);
  fileIssues.push(...noteIssues);
  const knownNoteKeys = new Set(notes.map((note) => note.noteKey));

  // 批次內重複偵測需要先掃一遍。
  const externalIdCounts = new Map<string, number>();
  const questionNumberCounts = new Map<number, number>();
  for (const item of rawQuestions) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const externalId = asString(row.externalId);
    if (externalId) externalIdCounts.set(externalId, (externalIdCounts.get(externalId) ?? 0) + 1);
    const number = asInt(row.questionNumber);
    if (number !== null) questionNumberCounts.set(number, (questionNumberCounts.get(number) ?? 0) + 1);
  }

  const rows = rawQuestions.map((item, rowIndex) =>
    validateRow(item, rowIndex, context, externalIdCounts, questionNumberCounts, knownNoteKeys),
  );

  const errorCount = rows.filter((r) => r.hasError).length;
  const warningCount = rows.filter(
    (r) => !r.hasError && r.issues.some((i) => i.level === 'warning'),
  ).length;

  return {
    fileIssues,
    rows,
    notes,
    errorCount,
    warningCount,
    validCount: rows.length - errorCount,
    reviewRequiredCount: rows.filter((r) => r.reviewRequired).length,
  };
}

function emptyResult(fileIssues: ImportIssue[]): ImportValidationResult {
  return {
    fileIssues,
    rows: [],
    notes: [],
    errorCount: 0,
    warningCount: 0,
    validCount: 0,
    reviewRequiredCount: 0,
  };
}

/**
 * 驗證 `notes` 區塊。
 *
 * 筆記的問題一律是**檔案層級**而非逐題：一段壞掉的筆記不屬於任何一題，
 * 掛在某個 rowIndex 上只會誤導。
 *
 * 缺少 notes 完全合法（1.0.0 的檔案就沒有），回傳空陣列。
 */
function validateNotes(raw: unknown): { notes: NormalizedImportNote[]; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  if (raw === undefined || raw === null) return { notes: [], issues };

  if (!Array.isArray(raw)) {
    issues.push(
      issue('error', IMPORT_ISSUE_CODES.INVALID_NOTE_SHAPE, 'notes 必須是陣列。', null, 'notes'),
    );
    return { notes: [], issues };
  }

  if (raw.length > MAX_NOTES_PER_IMPORT) {
    issues.push(
      issue(
        'error',
        IMPORT_ISSUE_CODES.TOO_MANY_NOTES,
        `筆記數量 ${raw.length} 超過單次匯入上限 ${MAX_NOTES_PER_IMPORT}。`,
        null,
        'notes',
      ),
    );
    return { notes: [], issues };
  }

  const notes: NormalizedImportNote[] = [];
  const seen = new Set<string>();

  raw.forEach((item, index) => {
    const path = `notes[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      issues.push(
        issue('error', IMPORT_ISSUE_CODES.INVALID_NOTE_SHAPE, `${path} 必須是物件。`, null, path),
      );
      return;
    }

    const row = item as Record<string, unknown>;
    const noteKey = asString(row.noteId);
    if (!noteKey) {
      issues.push(
        issue(
          'error',
          IMPORT_ISSUE_CODES.INVALID_NOTE_SHAPE,
          `${path}.noteId 為必填，且必須是非空字串。`,
          null,
          `${path}.noteId`,
        ),
      );
      return;
    }

    if (seen.has(noteKey)) {
      issues.push(
        issue(
          'error',
          IMPORT_ISSUE_CODES.DUPLICATE_NOTE_ID,
          `noteId「${noteKey}」在同一份檔案中重複。`,
          null,
          `${path}.noteId`,
        ),
      );
      return;
    }
    seen.add(noteKey);

    const content = asString(row.content);
    if (!content) {
      issues.push(
        issue(
          'error',
          IMPORT_ISSUE_CODES.EMPTY_NOTE_CONTENT,
          `筆記「${noteKey}」的 content 不可為空。`,
          null,
          `${path}.content`,
        ),
      );
      return;
    }

    if (content.length > NOTE_CONTENT_MAX_CHARS) {
      issues.push(
        issue(
          'error',
          IMPORT_ISSUE_CODES.NOTE_CONTENT_TOO_LONG,
          `筆記「${noteKey}」長度 ${content.length} 超過上限 ${NOTE_CONTENT_MAX_CHARS}，請拆成多筆。`,
          null,
          `${path}.content`,
        ),
      );
      return;
    }

    notes.push({
      noteKey,
      title: asString(row.title),
      content,
      sourcePage: asInt(row.sourcePage),
      // 關鍵字只做正規化，不驗證內容——它是檢索的輔助，缺了也還有正文可比對。
      keywords: Array.isArray(row.keywords)
        ? row.keywords.map(asString).filter((k): k is string => k !== null)
        : [],
    });
  });

  return { notes, issues };
}

function validateRow(
  item: unknown,
  rowIndex: number,
  context: ImportValidationContext,
  externalIdCounts: Map<string, number>,
  questionNumberCounts: Map<number, number>,
  knownNoteKeys: ReadonlySet<string>,
): NormalizedImportQuestion {
  const issues: ImportIssue[] = [];
  const add = (
    level: ImportIssueLevel,
    code: ImportIssueCode,
    message: string,
    fieldPath?: string,
  ) => issues.push(issue(level, code, message, rowIndex, fieldPath));

  const base: NormalizedImportQuestion = {
    rowIndex,
    externalId: null,
    questionNumber: null,
    type: null,
    stem: null,
    options: null,
    explanation: null,
    sourcePage: null,
    sourceReference: null,
    reviewRequired: false,
    reviewReason: null,
    relatedNoteIds: [],
    issues,
    hasError: false,
  };

  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    add('error', IMPORT_ISSUE_CODES.INVALID_ROW_SHAPE, '此筆題目不是一個 JSON 物件。');
    return { ...base, hasError: true };
  }

  const row = item as Record<string, unknown>;

  // --- relatedNoteIds（1.1.0）---
  //
  // 引用不存在的 noteId 是 error 而不是 warning：靜靜忽略它，
  // 使用者會以為這題掛了筆記，實際上分析時根本沒帶進去——
  // 而那正是最難察覺的那種失效。
  if (row.relatedNoteIds !== undefined && row.relatedNoteIds !== null) {
    if (!Array.isArray(row.relatedNoteIds)) {
      add('error', IMPORT_ISSUE_CODES.INVALID_ROW_SHAPE, 'relatedNoteIds 必須是陣列。', 'relatedNoteIds');
    } else {
      const referenced = row.relatedNoteIds
        .map(asString)
        .filter((key): key is string => key !== null);
      const unknown = referenced.filter((key) => !knownNoteKeys.has(key));
      if (unknown.length > 0) {
        add(
          'error',
          IMPORT_ISSUE_CODES.UNKNOWN_NOTE_REFERENCE,
          `relatedNoteIds 指向檔案中不存在的筆記：${unknown.join('、')}。`,
          'relatedNoteIds',
        );
      }
      // 去重後保留順序：重複引用同一段筆記沒有意義，但也不值得報錯。
      base.relatedNoteIds = [...new Set(referenced.filter((key) => knownNoteKeys.has(key)))];
    }
  }

  // --- externalId ---
  base.externalId = asString(row.externalId);
  if (!base.externalId) {
    add('warning', IMPORT_ISSUE_CODES.MISSING_EXTERNAL_ID, '缺少 externalId，日後無法對應回原始檔案。', 'externalId');
  } else {
    if ((externalIdCounts.get(base.externalId) ?? 0) > 1) {
      add('error', IMPORT_ISSUE_CODES.DUPLICATE_EXTERNAL_ID_IN_BATCH, `externalId「${base.externalId}」在此檔案中重複。`, 'externalId');
    }
    if (context.existingExternalIds.has(base.externalId)) {
      add('error', IMPORT_ISSUE_CODES.DUPLICATE_EXTERNAL_ID_IN_DB, `externalId「${base.externalId}」已存在於題庫中。`, 'externalId');
    }
  }

  // --- 題號 ---
  base.questionNumber = asInt(row.questionNumber);
  if (base.questionNumber === null) {
    add('error', IMPORT_ISSUE_CODES.INVALID_QUESTION_NUMBER, 'questionNumber 必須是整數。', 'questionNumber');
  } else if (base.questionNumber <= 0) {
    add('error', IMPORT_ISSUE_CODES.INVALID_QUESTION_NUMBER, 'questionNumber 必須是正整數。', 'questionNumber');
  } else {
    if ((questionNumberCounts.get(base.questionNumber) ?? 0) > 1) {
      add('error', IMPORT_ISSUE_CODES.DUPLICATE_QUESTION_NUMBER_IN_BATCH, `題號 ${base.questionNumber} 在此檔案中重複。`, 'questionNumber');
    }
    if (context.existingQuestionNumbers.has(base.questionNumber)) {
      add('error', IMPORT_ISSUE_CODES.DUPLICATE_QUESTION_NUMBER_IN_DB, `題號 ${base.questionNumber} 已存在於目標題組。`, 'questionNumber');
    }
  }

  // --- 題型 ---
  const type = asString(row.type);
  if (type === 'single_choice' || type === 'multiple_choice') {
    base.type = type;
  } else {
    add('error', IMPORT_ISSUE_CODES.INVALID_QUESTION_TYPE, `題型必須是 single_choice 或 multiple_choice，收到「${String(row.type)}」。`, 'type');
  }

  // --- 題幹 ---
  base.stem = asString(row.stem);
  if (!base.stem) {
    add('error', IMPORT_ISSUE_CODES.EMPTY_STEM, '題幹不可為空。', 'stem');
  } else if (base.stem.length > (context.stemWarningLength ?? DEFAULT_STEM_WARNING_LENGTH)) {
    add('warning', IMPORT_ISSUE_CODES.STEM_TOO_LONG, '題幹異常長，請確認跨頁題目是否被錯誤合併。', 'stem');
  }

  // --- 選項與正確答案 ---
  const rawOptions = row.options;
  const rawCorrect = row.correctAnswers;

  if (!Array.isArray(rawOptions)) {
    add('error', IMPORT_ISSUE_CODES.TOO_FEW_OPTIONS, 'options 必須是陣列。', 'options');
  } else {
    if (rawOptions.length < 2) {
      add('error', IMPORT_ISSUE_CODES.TOO_FEW_OPTIONS, `至少需要兩個選項，目前有 ${rawOptions.length} 個。`, 'options');
    }

    const parsed: NormalizedOption[] = [];
    const seenKeys = new Set<string>();
    const duplicatedKeys = new Set<string>();

    rawOptions.forEach((opt, optIndex) => {
      if (typeof opt !== 'object' || opt === null) {
        add('error', IMPORT_ISSUE_CODES.INVALID_ROW_SHAPE, `第 ${optIndex + 1} 個選項不是物件。`, `options[${optIndex}]`);
        return;
      }
      const o = opt as Record<string, unknown>;
      const key = asString(o.key);
      const text = asString(o.text);

      if (!key) {
        add('error', IMPORT_ISSUE_CODES.INVALID_ROW_SHAPE, `第 ${optIndex + 1} 個選項缺少 key。`, `options[${optIndex}].key`);
        return;
      }
      if (!/^[A-Z]$/.test(key)) {
        if (/^[a-z]$/.test(key)) {
          add('warning', IMPORT_ISSUE_CODES.OPTION_KEY_NOT_UPPERCASE, `選項代號「${key}」不是大寫，匯入時會自動轉為大寫。`, `options[${optIndex}].key`);
        } else {
          add('error', IMPORT_ISSUE_CODES.INVALID_ROW_SHAPE, `選項代號「${key}」必須是單一英文字母。`, `options[${optIndex}].key`);
          return;
        }
      }
      const normalizedKey = key.toUpperCase();

      if (!text) {
        add('error', IMPORT_ISSUE_CODES.EMPTY_OPTION_TEXT, `選項「${normalizedKey}」的內容不可為空。`, `options[${optIndex}].text`);
      }

      if (seenKeys.has(normalizedKey)) duplicatedKeys.add(normalizedKey);
      seenKeys.add(normalizedKey);

      parsed.push({ key: normalizedKey, text: text ?? '', isCorrect: false });
    });

    if (duplicatedKeys.size > 0) {
      add('error', IMPORT_ISSUE_CODES.DUPLICATE_OPTION_KEY, `選項代號重複：${[...duplicatedKeys].join('、')}。`, 'options');
    }

    // --- 正確答案 ---
    if (!Array.isArray(rawCorrect)) {
      add('error', IMPORT_ISSUE_CODES.NO_CORRECT_ANSWER, 'correctAnswers 必須是陣列。', 'correctAnswers');
    } else {
      const correctKeys = rawCorrect
        .map((v) => asString(v)?.toUpperCase())
        .filter((v): v is string => Boolean(v));
      const uniqueCorrect = [...new Set(correctKeys)];

      if (uniqueCorrect.length === 0) {
        add('error', IMPORT_ISSUE_CODES.NO_CORRECT_ANSWER, '必須至少有一個正確答案。', 'correctAnswers');
      }

      const missing = uniqueCorrect.filter((k) => !seenKeys.has(k));
      if (missing.length > 0) {
        add('error', IMPORT_ISSUE_CODES.CORRECT_ANSWER_NOT_IN_OPTIONS, `正確答案「${missing.join('、')}」不存在於選項中。`, 'correctAnswers');
      }

      for (const option of parsed) {
        option.isCorrect = uniqueCorrect.includes(option.key);
      }

      if (base.type === 'single_choice' && uniqueCorrect.length > 1) {
        add('error', IMPORT_ISSUE_CODES.SINGLE_CHOICE_MULTIPLE_ANSWERS, `單選題只能有一個正確答案，目前有 ${uniqueCorrect.length} 個。`, 'correctAnswers');
      }
      if (base.type === 'multiple_choice' && uniqueCorrect.length < 2) {
        add('error', IMPORT_ISSUE_CODES.MULTIPLE_CHOICE_TOO_FEW_ANSWERS, `複選題至少需要兩個正確答案，目前有 ${uniqueCorrect.length} 個。`, 'correctAnswers');
      }
    }

    base.options = parsed;
  }

  // --- 解析 ---
  base.explanation = asString(row.explanation);
  if (!base.explanation) {
    // 只標示、絕不自動編造（規格 §5）。這是 warning，不阻擋 commit。
    add('warning', IMPORT_ISSUE_CODES.MISSING_EXPLANATION, '此題沒有解析，匯入後為空白（系統不會自動產生）。', 'explanation');
  }

  // --- 來源頁碼 ---
  if (row.sourcePage !== undefined && row.sourcePage !== null) {
    const page = asInt(row.sourcePage);
    if (page === null || page <= 0) {
      add('error', IMPORT_ISSUE_CODES.INVALID_SOURCE_PAGE, 'sourcePage 必須是正整數或 null。', 'sourcePage');
    } else {
      base.sourcePage = page;
    }
  }

  base.sourceReference = asString(row.sourceReference);

  // --- 需人工複核 ---
  base.reviewRequired = row.reviewRequired === true;
  base.reviewReason = asString(row.reviewReason);
  if (base.reviewRequired) {
    add('warning', IMPORT_ISSUE_CODES.REVIEW_REQUIRED, '此題已標記為需人工複核。', 'reviewRequired');
    if (!base.reviewReason) {
      add('warning', IMPORT_ISSUE_CODES.MISSING_REVIEW_REASON, '標記需複核但未說明原因。', 'reviewReason');
    }
  }

  base.hasError = issues.some((i) => i.level === 'error');
  return base;
}
