import {
  IMPORT_ISSUE_CODES,
  MAX_GROUPS_PER_IMPORT,
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
  /** 所屬題組在批次中的順序。 */
  groupIndex: number;
  issues: ImportIssue[];
  /** 有任何 error 級問題就不可 commit。 */
  hasError: boolean;
}

/** 一個題組（同一科目下的一個章節／一份題本）。 */
export interface NormalizedImportGroup {
  /** 在整個批次中的順序。 */
  groupIndex: number;
  /** 多檔上傳時的來源檔名，讓使用者對得回是哪一份。 */
  sourceFilename: string | null;
  chapterName: string | null;
  groupName: string;
  source: string | null;
  year: number | null;
  /** 題組層級備註（questionGroup.notes），不是章節筆記。 */
  groupNotes: string | null;
  studyNotes: NormalizedImportNote[];
  rows: NormalizedImportQuestion[];
  errorCount: number;
  warningCount: number;
  validCount: number;
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
  /** 全批次共用的科目名稱。多檔上傳時各檔必須一致。 */
  subjectName: string | null;
  /**
   * 題組清單。
   *
   * 1.0.0／1.1.0 的單題組檔案會被正規化成只有一個元素的清單，
   * 因此**下游只需要處理一種形狀**——不必到處判斷「這是舊格式還是新格式」。
   */
  groups: NormalizedImportGroup[];
  /** 所有題組的題目攤平，`rowIndex` 在整個批次內唯一。 */
  rows: NormalizedImportQuestion[];
  /** 所有題組的筆記攤平。 */
  notes: NormalizedImportNote[];
  errorCount: number;
  warningCount: number;
  validCount: number;
  reviewRequiredCount: number;
}

/** 一份待驗證的上傳檔案。 */
export interface ImportFileInput {
  filename: string | null;
  raw: unknown;
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

/**
 * 驗證整份匯入檔（單檔）。
 *
 * 只是 `validateImportFiles` 的單檔捷徑，兩者共用完全相同的規則。
 */
export function validateImportFile(
  raw: unknown,
  context: ImportValidationContext,
): ImportValidationResult {
  return validateImportFiles([{ filename: null, raw }], context);
}

/**
 * 驗證一次上傳的所有檔案。
 *
 * 兩種「多題組」輸入在這裡被正規化成同一種形狀：
 *
 *   - 單一檔案內的 `questionGroups` 陣列（格式 1.2.0）
 *   - 一次上傳多個舊格式檔案（每檔一個題組）
 *
 * 正規化只在這一支做，下游因此只有一條路徑。
 */
export function validateImportFiles(
  files: readonly ImportFileInput[],
  context: ImportValidationContext,
): ImportValidationResult {
  const fileIssues: ImportIssue[] = [];

  if (files.length === 0) {
    fileIssues.push(
      issue('error', IMPORT_ISSUE_CODES.INVALID_FILE_STRUCTURE, '沒有可匯入的檔案。', null),
    );
    return emptyResult(fileIssues);
  }

  /*
   * externalId 必須全批次唯一，因此要先掃過所有檔案的所有題目再逐題驗證。
   * 題號則**只在題組內**唯一——不同章節的第 1 題本來就會重複，
   * 而每個題組 commit 後各自是一個 question_group，資料庫的唯一索引也是那個範圍。
   */
  const externalIdCounts = new Map<string, number>();
  const parsed: { subjectName: string | null; rawGroups: RawGroup[] }[] = [];

  for (const input of files) {
    const label = files.length > 1 && input.filename ? input.filename + '：' : '';
    if (typeof input.raw !== 'object' || input.raw === null || Array.isArray(input.raw)) {
      fileIssues.push(
        issue(
          'error',
          IMPORT_ISSUE_CODES.INVALID_FILE_STRUCTURE,
          label + '檔案最外層必須是一個 JSON 物件。',
          null,
        ),
      );
      continue;
    }

    const file = input.raw as Record<string, unknown>;

    const schemaVersion = asString(file.schemaVersion);
    if (!schemaVersion) {
      fileIssues.push(
        issue(
          'error',
          IMPORT_ISSUE_CODES.UNSUPPORTED_SCHEMA_VERSION,
          label + '缺少 schemaVersion 欄位。',
          null,
          'schemaVersion',
        ),
      );
    } else if (!(SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(schemaVersion)) {
      fileIssues.push(
        issue(
          'error',
          IMPORT_ISSUE_CODES.UNSUPPORTED_SCHEMA_VERSION,
          label +
            '不支援的 schemaVersion「' +
            schemaVersion +
            '」，目前僅支援：' +
            SUPPORTED_SCHEMA_VERSIONS.join('、') +
            '。',
          null,
          'schemaVersion',
        ),
      );
    }

    const subject = file.subject as Record<string, unknown> | undefined;
    const subjectName = subject ? asString(subject.name) : null;
    if (!subjectName) {
      fileIssues.push(
        issue(
          'error',
          IMPORT_ISSUE_CODES.INVALID_FILE_STRUCTURE,
          label + 'subject.name 為必填。',
          null,
          'subject.name',
        ),
      );
    }

    const extracted = extractGroups(file, label, input.filename);
    fileIssues.push(...extracted.issues);

    for (const group of extracted.groups) {
      for (const item of group.rawQuestions) {
        if (typeof item !== 'object' || item === null) continue;
        const externalId = asString((item as Record<string, unknown>).externalId);
        if (externalId) {
          externalIdCounts.set(externalId, (externalIdCounts.get(externalId) ?? 0) + 1);
        }
      }
    }

    parsed.push({ subjectName, rawGroups: extracted.groups });
  }

  // 多檔上傳時科目必須一致：不同科目的題目混進同一個批次，
  // 「這一批要匯到哪裡」就沒有唯一答案了。
  const subjectNames = [
    ...new Set(parsed.map((p) => p.subjectName).filter((n): n is string => n !== null)),
  ];
  if (subjectNames.length > 1) {
    fileIssues.push(
      issue(
        'error',
        IMPORT_ISSUE_CODES.SUBJECT_MISMATCH_ACROSS_FILES,
        '一次匯入的檔案必須屬於同一個科目，但收到了：' + subjectNames.join('、') + '。',
        null,
        'subject.name',
      ),
    );
  }

  const allRawGroups = parsed.flatMap((p) => p.rawGroups);
  if (allRawGroups.length > MAX_GROUPS_PER_IMPORT) {
    fileIssues.push(
      issue(
        'error',
        IMPORT_ISSUE_CODES.TOO_MANY_GROUPS,
        '題組數量 ' +
          allRawGroups.length +
          ' 超過單次匯入上限 ' +
          MAX_GROUPS_PER_IMPORT +
          '。',
        null,
      ),
    );
    return emptyResult(fileIssues, subjectNames[0] ?? null);
  }

  const totalQuestions = allRawGroups.reduce((sum, g) => sum + g.rawQuestions.length, 0);
  if (totalQuestions > context.maxQuestions) {
    fileIssues.push(
      issue(
        'error',
        IMPORT_ISSUE_CODES.TOO_MANY_QUESTIONS,
        '題目數量 ' + totalQuestions + ' 超過單次匯入上限 ' + context.maxQuestions + '。',
        null,
        'questions',
      ),
    );
  }
  if (totalQuestions === 0) {
    fileIssues.push(
      issue(
        'error',
        IMPORT_ISSUE_CODES.INVALID_FILE_STRUCTURE,
        '沒有任何題目可以匯入。',
        null,
        'questions',
      ),
    );
  }

  // rowIndex 必須在整個批次內唯一（資料庫唯一索引是 batchId + rowIndex），
  // 因此用跨題組的流水號，而不是各題組自己從 0 起算。
  let rowIndex = 0;
  const groups: NormalizedImportGroup[] = allRawGroups.map((raw, groupIndex) => {
    const noteResult = validateNotes(raw.rawNotes, raw.label);
    fileIssues.push(...noteResult.issues);
    const knownNoteKeys = new Set(noteResult.notes.map((note) => note.noteKey));

    // 題號重複只在題組內判定。
    const questionNumberCounts = new Map<number, number>();
    for (const item of raw.rawQuestions) {
      if (typeof item !== 'object' || item === null) continue;
      const number = asInt((item as Record<string, unknown>).questionNumber);
      if (number !== null) {
        questionNumberCounts.set(number, (questionNumberCounts.get(number) ?? 0) + 1);
      }
    }

    const rows = raw.rawQuestions.map((item) =>
      validateRow(
        item,
        rowIndex++,
        groupIndex,
        context,
        externalIdCounts,
        questionNumberCounts,
        knownNoteKeys,
      ),
    );

    const errorCount = rows.filter((r) => r.hasError).length;
    return {
      groupIndex,
      sourceFilename: raw.sourceFilename,
      chapterName: raw.chapterName,
      groupName: raw.groupName,
      source: raw.source,
      year: raw.year,
      groupNotes: raw.groupNotes,
      studyNotes: noteResult.notes,
      rows,
      errorCount,
      warningCount: rows.filter(
        (r) => !r.hasError && r.issues.some((i) => i.level === 'warning'),
      ).length,
      validCount: rows.length - errorCount,
    };
  });

  const rows = groups.flatMap((g) => g.rows);
  const errorCount = rows.filter((r) => r.hasError).length;

  return {
    fileIssues,
    subjectName: subjectNames[0] ?? null,
    groups,
    rows,
    notes: groups.flatMap((g) => g.studyNotes),
    errorCount,
    warningCount: rows.filter((r) => !r.hasError && r.issues.some((i) => i.level === 'warning'))
      .length,
    validCount: rows.length - errorCount,
    reviewRequiredCount: rows.filter((r) => r.reviewRequired).length,
  };
}

/** 尚未逐題驗證的題組原始資料。 */
interface RawGroup {
  sourceFilename: string | null;
  label: string;
  chapterName: string | null;
  groupName: string;
  source: string | null;
  year: number | null;
  groupNotes: string | null;
  rawNotes: unknown;
  rawQuestions: unknown[];
}

/**
 * 從一份檔案取出題組清單。
 *
 * 1.2.0 用 `questionGroups` 陣列；更早的版本是單一題組平鋪在檔案根層。
 * 兩者在這裡收斂成同一種形狀——**這是整個功能唯一需要分辨格式的地方**。
 */
function extractGroups(
  file: Record<string, unknown>,
  label: string,
  filename: string | null,
): { groups: RawGroup[]; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];

  const toGroup = (
    meta: Record<string, unknown>,
    chapter: unknown,
    rawNotes: unknown,
    rawQuestions: unknown,
    groupLabel: string,
  ): RawGroup | null => {
    const groupName = asString(meta.name);
    if (!groupName) {
      issues.push(
        issue(
          'error',
          IMPORT_ISSUE_CODES.INVALID_FILE_STRUCTURE,
          groupLabel + '題組名稱為必填。',
          null,
          'questionGroup.name',
        ),
      );
      return null;
    }
    if (!Array.isArray(rawQuestions)) {
      issues.push(
        issue(
          'error',
          IMPORT_ISSUE_CODES.INVALID_FILE_STRUCTURE,
          groupLabel + 'questions 必須是陣列。',
          null,
          'questions',
        ),
      );
      return null;
    }
    const hasChapter = typeof chapter === 'object' && chapter !== null;
    return {
      sourceFilename: filename,
      label: groupLabel,
      chapterName: hasChapter ? asString((chapter as Record<string, unknown>).name) : null,
      groupName,
      source: asString(meta.source),
      year: asInt(meta.year),
      groupNotes: asString(meta.notes),
      rawNotes,
      rawQuestions,
    };
  };

  // --- 1.2.0：questionGroups 陣列 ---
  if (file.questionGroups !== undefined && file.questionGroups !== null) {
    if (!Array.isArray(file.questionGroups)) {
      issues.push(
        issue(
          'error',
          IMPORT_ISSUE_CODES.INVALID_GROUP_SHAPE,
          label + 'questionGroups 必須是陣列。',
          null,
          'questionGroups',
        ),
      );
      return { groups: [], issues };
    }
    const groups: RawGroup[] = [];
    file.questionGroups.forEach((item, index) => {
      const groupLabel = label + 'questionGroups[' + index + '] ';
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        issues.push(
          issue('error', IMPORT_ISSUE_CODES.INVALID_GROUP_SHAPE, groupLabel + '必須是物件。', null),
        );
        return;
      }
      const entry = item as Record<string, unknown>;
      /*
       * 1.2.0 的 `notes` 一個鍵背了兩個用途：舊格式裡題組備註是
       * `questionGroup.notes`（字串）、章節筆記是根層 `notes`（陣列），
       * 兩者在題組物件裡撞在一起。以型別分流——字串是備註、陣列是章節筆記——
       * 否則寫了備註的人會拿到看不懂的「notes 必須是陣列」。
       */
      const rawNotes = typeof entry.notes === 'string' ? undefined : entry.notes;
      const group = toGroup(entry, entry.chapter, rawNotes, entry.questions, groupLabel);
      if (group) groups.push(group);
    });
    return { groups, issues };
  }

  // --- 1.0.0 / 1.1.0：單一題組平鋪在根層 ---
  const meta = (file.questionGroup ?? {}) as Record<string, unknown>;
  const group = toGroup(meta, file.chapter, file.notes, file.questions, label);
  return { groups: group ? [group] : [], issues };
}

/** 完全無法處理時的空結果。 */
function emptyResult(
  fileIssues: ImportIssue[],
  subjectName: string | null = null,
): ImportValidationResult {
  return {
    fileIssues,
    subjectName,
    groups: [],
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
function validateNotes(
  raw: unknown,
  label: string,
): { notes: NormalizedImportNote[]; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  if (raw === undefined || raw === null) return { notes: [], issues };

  if (!Array.isArray(raw)) {
    issues.push(
      issue('error', IMPORT_ISSUE_CODES.INVALID_NOTE_SHAPE, label + 'notes 必須是陣列。', null, 'notes'),
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
  groupIndex: number,
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
    groupIndex,
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
