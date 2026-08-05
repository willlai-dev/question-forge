/**
 * Phase 1b 端到端驗證：題目 CRUD 與 JSON 匯入。
 *
 * 以 Node fetch 執行，避免 shell 字碼頁轉換污染中文測試資料。
 * 需先啟動後端；預設打測試後端 :4101，可用 BASE 覆寫。
 */
// 預設打測試後端（:4101）而非開發後端（:4000）：這些腳本會實際建立科目、
// 題目與作答紀錄，誤打到正式資料庫會污染真實題庫。要換目標請設 BASE。
const BASE = process.env.BASE ?? 'http://localhost:4101/api/v1';

// 題號在題組內唯一，因此固定的匯入題組會讓第二次執行多出「題號重複」錯誤，
// 使 errorCount 的斷言失準。每次執行換一個題組名稱即可重複跑。
const stamp = Date.now().toString(36);

const jar = new Map();
let pass = 0;
let fail = 0;

const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

function absorb(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const idx = pair.indexOf('=');
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

async function call(method, path, body, extraHeaders = {}) {
  const headers = { Cookie: cookieHeader(), ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  absorb(res);
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, body: json };
}

async function upload(path, filename, content, csrf) {
  const form = new FormData();
  form.append('file', new Blob([JSON.stringify(content)], { type: 'application/json' }), filename);
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Cookie: cookieHeader(), 'X-CSRF-Token': csrf },
    body: form,
  });
  absorb(res);
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, body: json };
}

/** 多檔上傳：同一個 `file` 欄位重複 append，對應後端的 FilesInterceptor。 */
async function uploadMany(path, files, csrf) {
  const form = new FormData();
  for (const f of files) {
    form.append(
      'file',
      new Blob([JSON.stringify(f.content)], { type: 'application/json' }),
      f.filename,
    );
  }
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Cookie: cookieHeader(), 'X-CSRF-Token': csrf },
    body: form,
  });
  absorb(res);
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, body: json };
}

function check(label, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ✔ ${label}`); }
  else { fail += 1; console.log(`  ✘ ${label} ${detail}`); }
}

let csrf = '';
const H = () => ({ 'X-CSRF-Token': csrf });
async function refreshCsrf() {
  csrf = (await call('GET', '/auth/csrf')).body.csrfToken;
}

const validQuestion = (n, overrides = {}) => ({
  // externalId 全域唯一：固定值會在第二次執行觸發 DUPLICATE_EXTERNAL_ID_IN_DB，
  // 讓 errorCount 多一筆，因此一併帶上本次執行的戳記。
  externalId: `E2E-${stamp}-${n}`,
  questionNumber: n,
  type: 'single_choice',
  stem: `第 ${n} 題：下列何者屬於行政處分？`,
  options: [
    { key: 'A', text: '行政指導' },
    { key: 'B', text: '拆除命令' },
    { key: 'C', text: '行政計畫' },
    { key: 'D', text: '行政契約' },
  ],
  correctAnswers: ['B'],
  explanation: null,
  sourcePage: n,
  sourceReference: '第三章',
  reviewRequired: false,
  reviewReason: null,
  ...overrides,
});

const importFile = (questions, overrides = {}) => ({
  schemaVersion: '1.0.0',
  subject: { name: '匯入測試科目' },
  chapter: { name: '匯入測試章節' },
  questionGroup: { name: `匯入測試題組-${stamp}`, source: '單元測試', year: 2026 },
  questions,
  ...overrides,
});

const run = async () => {
  console.log('\n=== 準備：登入 ===');
  await refreshCsrf();
  const status = await call('GET', '/auth/bootstrap');
  if (status.body.canBootstrap) {
    await call('POST', '/auth/bootstrap',
      { username: 'probe', password: 'probe-password-123', confirmPassword: 'probe-password-123' }, H());
  } else {
    await call('POST', '/auth/login', { username: 'probe', password: 'probe-password-123' }, H());
  }
  const me = await call('GET', '/auth/me');
  check('已登入', me.status === 200);

  const subject = await call('POST', '/subjects', { name: `題目測試科目 ${Date.now() % 100000}` }, H());
  const group = await call('POST', '/question-groups', { subjectId: subject.body.id, name: '手動建題題組' }, H());
  check('建立測試科目與題組', subject.status === 201 && group.status === 201);

  console.log('\n=== 題目 CRUD ===');
  const created = await call('POST', '/questions', {
    questionGroupId: group.body.id,
    questionNumber: 1,
    type: 'single_choice',
    stem: '下列何者屬於行政處分？',
    options: [
      { key: 'A', text: '行政指導', isCorrect: false },
      { key: 'B', text: '拆除命令', isCorrect: true },
    ],
    explanation: null,
    reviewRequired: false,
  }, H());
  check('建立單選題', created.status === 201, JSON.stringify(created.body));
  check('中文題幹往返正確', created.body?.stem === '下列何者屬於行政處分？');
  check('explanation 保持 null（系統不編造解析）', created.body?.explanation === null);
  check('contentHash 為 sha256', /^[0-9a-f]{64}$/.test(created.body?.contentHash ?? ''));
  check('初始版本為 1', created.body?.currentVersion === 1);

  const badSingle = await call('POST', '/questions', {
    questionGroupId: group.body.id, questionNumber: 2, type: 'single_choice',
    stem: '題幹', options: [
      { key: 'A', text: '甲', isCorrect: true },
      { key: 'B', text: '乙', isCorrect: true },
    ], reviewRequired: false,
  }, H());
  check('單選題有兩個答案 → 400', badSingle.status === 400 && badSingle.body.error.code === 'VALIDATION_FAILED');

  const badMulti = await call('POST', '/questions', {
    questionGroupId: group.body.id, questionNumber: 2, type: 'multiple_choice',
    stem: '題幹', options: [
      { key: 'A', text: '甲', isCorrect: true },
      { key: 'B', text: '乙', isCorrect: false },
    ], reviewRequired: false,
  }, H());
  check('複選題只有一個答案 → 400', badMulti.status === 400);

  const dupKey = await call('POST', '/questions', {
    questionGroupId: group.body.id, questionNumber: 2, type: 'single_choice',
    stem: '題幹', options: [
      { key: 'A', text: '甲', isCorrect: true },
      { key: 'A', text: '乙', isCorrect: false },
    ], reviewRequired: false,
  }, H());
  check('選項代號重複 → 400', dupKey.status === 400);

  const oneOption = await call('POST', '/questions', {
    questionGroupId: group.body.id, questionNumber: 2, type: 'single_choice',
    stem: '題幹', options: [{ key: 'A', text: '甲', isCorrect: true }], reviewRequired: false,
  }, H());
  check('只有一個選項 → 400', oneOption.status === 400);

  const dupNumber = await call('POST', '/questions', {
    questionGroupId: group.body.id, questionNumber: 1, type: 'single_choice',
    stem: '重複題號', options: [
      { key: 'A', text: '甲', isCorrect: true },
      { key: 'B', text: '乙', isCorrect: false },
    ], reviewRequired: false,
  }, H());
  check('同題組重複題號 → 409', dupNumber.status === 409, `status=${dupNumber.status}`);

  const hashBefore = created.body.contentHash;
  const updated = await call('PATCH', `/questions/${created.body.id}`, {
    questionNumber: 1, type: 'single_choice', stem: '修改後的題幹',
    options: [
      { key: 'A', text: '行政指導', isCorrect: false },
      { key: 'B', text: '拆除命令', isCorrect: true },
    ],
    explanation: '補上解析', reviewRequired: false,
  }, H());
  check('更新題目成功', updated.status === 200);
  check('版本遞增為 2', updated.body?.currentVersion === 2);
  check('題幹變更 → contentHash 改變', updated.body?.contentHash !== hashBefore);

  const versions = await call('GET', `/questions/${created.body.id}/versions`);
  check('版本歷史有 2 筆快照', versions.body?.length === 2, `len=${versions.body?.length}`);

  console.log('\n=== 匯入：錯誤檔案不得寫入正式題庫 ===');
  const before = await call('GET', '/questions?pageSize=1');
  const countBefore = before.body.pagination.total;

  const badBatch = await upload('/imports', 'bad.json', importFile([
    validQuestion(1),
    validQuestion(2, { stem: '' }),
    validQuestion(3, { correctAnswers: ['Z'] }),
    validQuestion(4, { type: 'fill_in_blank' }),
  ]), csrf);
  check('上傳含錯誤的檔案 → 201', badBatch.status === 201, JSON.stringify(badBatch.body)?.slice(0, 200));
  check('批次狀態為 partially_valid', badBatch.body?.status === 'partially_valid', `status=${badBatch.body?.status}`);
  check('errorCount = 3', badBatch.body?.errorCount === 3, `errorCount=${badBatch.body?.errorCount}`);
  check('canCommit 為 false', badBatch.body?.canCommit === false);

  const blockedCommit = await call('POST', `/imports/${badBatch.body.id}/commit`, {}, H());
  check('有錯誤時 commit → 400 IMPORT_HAS_BLOCKING_ERRORS',
    blockedCommit.status === 400 && blockedCommit.body.error.code === 'IMPORT_HAS_BLOCKING_ERRORS',
    JSON.stringify(blockedCommit.body));

  const afterBlocked = await call('GET', '/questions?pageSize=1');
  check('正式題庫題數完全沒有增加', afterBlocked.body.pagination.total === countBefore,
    `${countBefore} → ${afterBlocked.body.pagination.total}`);

  console.log('\n=== 匯入：預覽、修正與排除 ===');
  const rows = await call('GET', `/imports/${badBatch.body.id}/questions`);
  check('可取得逐題驗證結果', rows.status === 200 && rows.body.length === 4);
  const emptyStemRow = rows.body.find((r) => r.rowIndex === 1);
  check('空題幹題目標記為 error', emptyStemRow?.status === 'error');
  check('錯誤訊息含 EMPTY_STEM', emptyStemRow?.issues.some((i) => i.code === 'EMPTY_STEM'));

  const fixed = await call('PATCH', `/imports/${badBatch.body.id}/questions/${emptyStemRow.id}`, {
    stem: '補上題幹之後的內容',
  }, H());
  check('修正後重新驗證', fixed.status === 200);
  check('修正後 errorCount 減為 2', fixed.body?.errorCount === 2, `errorCount=${fixed.body?.errorCount}`);

  const stillBad = rows.body.filter((r) => r.rowIndex >= 2);
  for (const row of stillBad) {
    await call('POST', `/imports/${badBatch.body.id}/questions/${row.id}/exclude`, undefined, H());
  }
  const afterExclude = await call('GET', `/imports/${badBatch.body.id}`);
  check('排除錯誤題後 canCommit 為 true', afterExclude.body?.canCommit === true,
    `errorCount=${afterExclude.body?.errorCount} canCommit=${afterExclude.body?.canCommit}`);

  const commit = await call('POST', `/imports/${badBatch.body.id}/commit`, {}, H());
  check('確認匯入成功', commit.status === 200, JSON.stringify(commit.body));
  check('只寫入 2 題（其餘被排除）', commit.body?.committedCount === 2, `committed=${commit.body?.committedCount}`);

  const afterCommit = await call('GET', '/questions?pageSize=1');
  check('正式題庫題數增加 2', afterCommit.body.pagination.total === countBefore + 2,
    `${countBefore} → ${afterCommit.body.pagination.total}`);

  const recommit = await call('POST', `/imports/${badBatch.body.id}/commit`, {}, H());
  check('重複 commit → 409', recommit.status === 409, `status=${recommit.status}`);

  console.log('\n=== 匯入：乾淨檔案一次通過 ===');
  const goodBatch = await upload('/imports', 'good.json', importFile([
    validQuestion(101), validQuestion(102, { explanation: '這題有解析' }),
    validQuestion(103, { reviewRequired: true, reviewReason: '答案存疑' }),
  ]), csrf);
  check('批次狀態為 validated', goodBatch.body?.status === 'validated', `status=${goodBatch.body?.status}`);
  check('errorCount = 0', goodBatch.body?.errorCount === 0);
  check('reviewRequiredCount = 1', goodBatch.body?.reviewRequiredCount === 1);
  check('缺解析被記為 warning', goodBatch.body?.warningCount >= 1, `warningCount=${goodBatch.body?.warningCount}`);

  const goodCommit = await call('POST', `/imports/${goodBatch.body.id}/commit`, {}, H());
  check('乾淨檔案 commit 成功且寫入 3 題', goodCommit.body?.committedCount === 3);

  const imported = await call('GET', `/questions?questionGroupId=${goodCommit.body.questionGroupId}&pageSize=50`);
  check('匯入的題目可查詢', imported.body.items.length === 3);
  const noExplanation = imported.body.items.find((q) => q.externalId === `E2E-${stamp}-101`);
  check('沒有解析的題目 explanation 仍為 null（未被編造）',
    noExplanation !== undefined && noExplanation.explanation === null,
    `externalIds=${imported.body.items.map((q) => q.externalId).join(',')}`);
  const withReview = imported.body.items.find((q) => q.externalId === `E2E-${stamp}-103`);
  check('reviewRequired 正確帶入', withReview?.reviewRequired === true);

  console.log('\n=== 篩選 ===');
  const byReview = await call('GET', '/questions?reviewRequired=true&pageSize=50');
  check('可依 reviewRequired 篩選', byReview.body.items.every((q) => q.reviewRequired === true));
  const noExp = await call('GET', '/questions?hasExplanation=false&pageSize=50');
  check('可依有無解析篩選', noExp.body.items.every((q) => q.explanation === null));
  const search = await call('GET', '/questions?q=行政處分&pageSize=50');
  check('可用中文關鍵字搜尋題幹', search.body.items.length > 0, `count=${search.body.items.length}`);

  console.log('\n=== 批次操作 ===');
  const targetGroup = await call('POST', '/question-groups', { subjectId: subject.body.id, name: '批次移動目標' }, H());
  const moveIds = imported.body.items.slice(0, 2).map((q) => q.id);
  const moved = await call('POST', '/questions/bulk', {
    questionIds: moveIds, action: 'move', targetQuestionGroupId: targetGroup.body.id,
  }, H());
  check('批次移動成功', moved.status === 200 && moved.body.affected === 2);

  const movedCheck = await call('GET', `/questions?questionGroupId=${targetGroup.body.id}&pageSize=50`);
  check('題目已移到目標題組', movedCheck.body.items.length === 2);
  check('移動後 subjectId 仍一致', movedCheck.body.items.every((q) => q.subjectId === subject.body.id));

  const flagged = await call('POST', '/questions/bulk', {
    questionIds: moveIds, action: 'setReviewRequired', reviewRequired: true,
  }, H());
  check('批次設定 reviewRequired', flagged.body?.affected === 2);

  const deleted = await call('POST', '/questions/bulk', { questionIds: moveIds, action: 'delete' }, H());
  check('批次刪除', deleted.body?.affected === 2);
  const afterDelete = await call('GET', `/questions?questionGroupId=${targetGroup.body.id}&pageSize=50`);
  check('刪除後查不到（軟刪除）', afterDelete.body.items.length === 0);

  const bulkBadTarget = await call('POST', '/questions/bulk', {
    questionIds: moveIds, action: 'move',
  }, H());
  check('move 未指定目標題組 → 400', bulkBadTarget.status === 400);

  console.log('\n=== 匯入輔助端點 ===');
  const schemaDoc = await call('GET', '/imports/schema');
  check('可取得匯入 JSON Schema', schemaDoc.status === 200 && schemaDoc.body?.title?.includes('題庫匯入'));
  const promptDoc = await call('GET', '/imports/prompt');
  check('可取得 PDF 整理 Prompt', promptDoc.status === 200 && promptDoc.body.prompt.includes('只輸出 JSON'));

  // 章節筆記（schemaVersion 1.1.0）。
  //
  // 使用者的單章 PDF 通常題目與筆記並存。筆記匯入後成為該題庫的本地資料源，
  // 供 AI 解析使用——比網路搜尋精準，而且不消耗 API 額度。
  console.log('\n=== 匯入：章節筆記（schemaVersion 1.1.0）===');

  const noteFile = (notes, questions, overrides = {}) => ({
    ...importFile(questions, overrides),
    schemaVersion: '1.1.0',
    questionGroup: { name: `筆記測試題組-${stamp}`, source: '單元測試', year: 2026 },
    notes,
  });

  const badNotes = await upload('/imports', 'bad-notes.json', noteFile(
    [{ noteId: 'N1', content: '第一段筆記' }],
    [validQuestion(201, { relatedNoteIds: ['N1', 'N-不存在'] })],
  ), csrf);
  check('引用不存在的 noteId → 該題為 error', badNotes.body?.errorCount === 1,
    `errorCount=${badNotes.body?.errorCount}`);
  const badNoteRows = await call('GET', `/imports/${badNotes.body.id}/questions`);
  check('**錯誤碼為 UNKNOWN_NOTE_REFERENCE（不是靜靜忽略）**',
    badNoteRows.body[0]?.issues.some((i) => i.code === 'UNKNOWN_NOTE_REFERENCE'),
    JSON.stringify(badNoteRows.body[0]?.issues.map((i) => i.code)));

  const dupNotes = await upload('/imports', 'dup-notes.json', noteFile(
    [{ noteId: 'N1', content: '第一段' }, { noteId: 'N1', content: '重複的 id' }],
    [validQuestion(202)],
  ), csrf);
  check('noteId 重複 → 檔案層錯誤',
    dupNotes.body?.fileIssues?.some((i) => i.code === 'DUPLICATE_NOTE_ID'),
    JSON.stringify(dupNotes.body?.fileIssues?.map((i) => i.code)));

  const notesBatch = await upload('/imports', 'notes.json', noteFile(
    [
      {
        noteId: 'N1',
        title: '行政處分的要件',
        content: '行政處分須為行政機關就公法上具體事件所為之單方行政行為，且對外直接發生法律效果。拆除命令即屬之。',
        sourcePage: 12,
        keywords: ['行政處分', '拆除命令'],
      },
      {
        noteId: 'N2',
        title: '行政指導',
        content: '行政指導不具法律拘束力，相對人得不遵從，因此不是行政處分。',
        sourcePage: 14,
        keywords: ['行政指導'],
      },
    ],
    [validQuestion(203, { relatedNoteIds: ['N1'] }), validQuestion(204)],
  ), csrf);
  check('含筆記的檔案通過驗證', notesBatch.body?.status === 'validated',
    `status=${notesBatch.body?.status} ${JSON.stringify(notesBatch.body?.fileIssues)}`);
  check('批次回報筆記數', notesBatch.body?.noteCount === 2, `noteCount=${notesBatch.body?.noteCount}`);

  const notesCommit = await call('POST', `/imports/${notesBatch.body.id}/commit`, {}, H());
  check('含筆記的檔案 commit 成功', notesCommit.status === 200 && notesCommit.body?.committedCount === 2,
    JSON.stringify(notesCommit.body));

  // 重新匯入同一份 PDF：同一個 (題組, noteKey) 應該是更新而不是再長一筆，
  // 否則檢索會同時撈到新舊兩版。
  const reimport = await upload('/imports', 'notes-again.json', noteFile(
    [{ noteId: 'N1', title: '行政處分的要件（修訂）', content: '修訂後的內容：行政處分必須對外直接發生法律效果。' }],
    [validQuestion(205)],
  ), csrf);
  const reimportCommit = await call('POST', `/imports/${reimport.body.id}/commit`, {
    targetGroupId: notesCommit.body.questionGroupId,
  }, H());
  check('重新匯入同一題組成功', reimportCommit.status === 200, JSON.stringify(reimportCommit.body));

  check('1.0.0 的舊檔案仍然匯得進來（新欄位全選填）',
    (await upload('/imports', 'legacy.json', importFile([validQuestion(206)]), csrf)).body?.status === 'validated');

  // 匯入目標與丟棄。
  //
  // 這兩件事後端契約一直都支援（commit 可帶 targetSubjectId / targetChapterId、
  // DELETE /imports/:id），但前端從來沒有接上——commit 一律送空物件。
  console.log('\n=== 匯入：指定目標科目與章節 ===');

  const destSubject = (await call('POST', '/subjects', { name: `指定科目-${stamp}` }, H())).body;
  const destChapter = (await call('POST', '/chapters',
    { subjectId: destSubject.id, name: `指定章節-${stamp}` }, H())).body;
  const otherSubject = (await call('POST', '/subjects', { name: `另一科目-${stamp}` }, H())).body;
  const otherChapter = (await call('POST', '/chapters',
    { subjectId: otherSubject.id, name: `另一章節-${stamp}` }, H())).body;
  check('建立兩組科目與章節', Boolean(destChapter?.id && otherChapter?.id));

  const targeted = await upload('/imports', 'targeted.json',
    importFile([validQuestion(301), validQuestion(302)]), csrf);
  check('待指定目標的批次已驗證', targeted.body?.status === 'validated',
    `status=${targeted.body?.status}`);

  // 章節屬於另一個科目 → 必須擋下，而且是可讀的 409 而不是外鍵爆掉的 500。
  const mismatch = await call('POST', `/imports/${targeted.body.id}/commit`, {
    targetSubjectId: destSubject.id,
    targetChapterId: otherChapter.id,
  }, H());
  check('**章節不屬於指定科目 → 409 CHAPTER_SUBJECT_MISMATCH**',
    mismatch.status === 409 && mismatch.body?.error?.code === 'CHAPTER_SUBJECT_MISMATCH',
    `status=${mismatch.status} code=${mismatch.body?.error?.code}`);

  const stillPending = await call('GET', `/imports/${targeted.body.id}`);
  check('被擋下之後批次仍可再次 commit', stillPending.body?.status !== 'committed',
    `status=${stillPending.body?.status}`);

  const targetedCommit = await call('POST', `/imports/${targeted.body.id}/commit`, {
    targetSubjectId: destSubject.id,
    targetChapterId: destChapter.id,
  }, H());
  check('指定科目與章節後 commit 成功', targetedCommit.status === 200,
    JSON.stringify(targetedCommit.body));
  check('回報的目標科目正確', targetedCommit.body?.subjectId === destSubject.id,
    `${targetedCommit.body?.subjectId} vs ${destSubject.id}`);
  check('**題目真的落在指定的章節**', targetedCommit.body?.chapterId === destChapter.id,
    `${targetedCommit.body?.chapterId} vs ${destChapter.id}`);

  const inChapter = await call('GET', `/questions?chapterId=${destChapter.id}&pageSize=50`);
  check('依章節查得到剛匯入的題目', inChapter.body?.pagination?.total === 2,
    `total=${inChapter.body?.pagination?.total}`);

  console.log('\n=== 匯入：丟棄不匯入 ===');
  const beforeDiscard = (await call('GET', '/questions?pageSize=1')).body.pagination.total;
  const toDiscard = await upload('/imports', 'discard-me.json',
    importFile([validQuestion(401), validQuestion(402)]), csrf);
  check('待丟棄的批次已建立', toDiscard.status === 201);

  const discarded = await call('DELETE', `/imports/${toDiscard.body.id}`, undefined, H());
  check('可以丟棄批次', discarded.status === 200 || discarded.status === 204,
    `status=${discarded.status}`);

  const afterDiscard = await call('GET', `/imports/${toDiscard.body.id}`);
  check('丟棄後狀態為 discarded', afterDiscard.body?.status === 'discarded',
    `status=${afterDiscard.body?.status}`);
  const totalNow = (await call('GET', '/questions?pageSize=1')).body.pagination.total;
  check('**丟棄不會動到正式題庫**', totalNow === beforeDiscard,
    `${beforeDiscard} → ${totalNow}`);

  const commitDiscarded = await call('POST', `/imports/${toDiscard.body.id}/commit`, {}, H());
  check('丟棄後不可再 commit', commitDiscarded.status >= 400,
    `status=${commitDiscarded.status}`);


  // ==================================================================
  // 多題組匯入：一次匯入同一科目、不同章節的多份題庫。
  // ==================================================================
  console.log('\n=== 多題組：多檔上傳合併成同一批 ===');

  const chapterFile = (chapter, questions) => ({
    schemaVersion: '1.0.0',
    subject: { name: `多題組測試科目-${stamp}` },
    chapter: { name: `${chapter}-${stamp}` },
    questionGroup: { name: `${chapter}題本-${stamp}`, source: '單元測試', year: 2026 },
    questions,
  });

  // 兩個檔案都用題號 1、2：這正是使用者的真實情境（各章自己從第 1 題開始）。
  const multi = await uploadMany('/imports', [
    { filename: 'ch1.json', content: chapterFile('多組第一章', [
      validQuestion(1, { externalId: `E2E-${stamp}-MG-A1`, questionNumber: 1 }),
      validQuestion(2, { externalId: `E2E-${stamp}-MG-A2`, questionNumber: 2 }),
    ]) },
    { filename: 'ch2.json', content: chapterFile('多組第二章', [
      validQuestion(1, { externalId: `E2E-${stamp}-MG-B1`, questionNumber: 1 }),
    ]) },
  ], csrf);

  check('多檔上傳建立單一批次', multi.status === 201, `status=${multi.status} ${JSON.stringify(multi.body).slice(0, 200)}`);
  check('批次含兩個題組', multi.body?.groups?.length === 2, `groups=${multi.body?.groups?.length}`);
  check('題目數合計為 3', multi.body?.totalCount === 3, `total=${multi.body?.totalCount}`);
  check('**跨檔重複題號不算錯誤**（題號只在題組內唯一）', multi.body?.errorCount === 0,
    `errorCount=${multi.body?.errorCount} ${JSON.stringify(multi.body?.groups)}`);
  check('題組記得自己來自哪個檔案',
    JSON.stringify(multi.body?.groups?.map((g) => g.sourceFilename)) === '["ch1.json","ch2.json"]',
    JSON.stringify(multi.body?.groups?.map((g) => g.sourceFilename)));

  const multiRows = await call('GET', `/imports/${multi.body.id}/questions`);
  const groupIds = new Set((multiRows.body ?? []).map((r) => r.importGroupId));
  check('**每一列都掛在題組上**（沒有孤兒列）', groupIds.size === 2 && !groupIds.has(null),
    `distinct=${groupIds.size}`);

  const multiCommit = await call('POST', `/imports/${multi.body.id}/commit`, {}, H());
  check('多題組可以 commit', multiCommit.status === 200 || multiCommit.status === 201,
    `status=${multiCommit.status} ${JSON.stringify(multiCommit.body).slice(0, 200)}`);
  check('commit 結果逐題組回報', multiCommit.body?.groups?.length === 2);
  check('三題全數寫入', multiCommit.body?.committedCount === 3,
    `committed=${multiCommit.body?.committedCount}`);

  // 每個題組各自建立一個 question_groups，且落在自己的章節。
  const createdGroupIds = multiCommit.body?.groups?.map((g) => g.questionGroupId) ?? [];
  check('**兩個題組各自建立獨立的題組**', new Set(createdGroupIds).size === 2,
    JSON.stringify(createdGroupIds));

  const mgSubjectId = multiCommit.body?.subjectId;
  check('commit 回報科目', Boolean(mgSubjectId));
  const listChapters = async () => {
    const res = await call('GET', `/subjects/${mgSubjectId}/chapters`);
    return res.body?.items ?? res.body ?? [];
  };
  const chapters = await listChapters();
  const ch1 = chapters.find((c) => c.name === `多組第一章-${stamp}`);
  const ch2 = chapters.find((c) => c.name === `多組第二章-${stamp}`);
  check('**兩個章節都自動建立**（同科目、不同章節）', Boolean(ch1) && Boolean(ch2));
  if (ch1 && ch2) {
    const inCh1 = await call('GET', `/questions?chapterId=${ch1.id}&pageSize=50`);
    const inCh2 = await call('GET', `/questions?chapterId=${ch2.id}&pageSize=50`);
    check('第一章拿到 2 題', inCh1.body?.pagination?.total === 2,
      `total=${inCh1.body?.pagination?.total}`);
    check('第二章拿到 1 題', inCh2.body?.pagination?.total === 1,
      `total=${inCh2.body?.pagination?.total}`);
    check('**同科目**：兩章屬於同一科目', ch1.subjectId === ch2.subjectId);
  }


  console.log('\n=== 多題組：指定既有題組 ===');
  // 匯進既有題組是舊有能力（章節筆記靠它更新），逐題組匯入不可以把它弄丟。
  const intoExisting = await upload('/imports', 'append.json',
    chapterFile('多組第一章', [
      validQuestion(9, { externalId: `E2E-${stamp}-MG-APPEND`, questionNumber: 9 }),
    ]), csrf);
  const appendCommit = await call('POST', `/imports/${intoExisting.body.id}/commit`,
    { targetGroupId: createdGroupIds[0] }, H());
  check('可以匯入既有題組', appendCommit.status === 200 || appendCommit.status === 201,
    `status=${appendCommit.status} ${JSON.stringify(appendCommit.body).slice(0, 200)}`);
  check('**targetGroupId 真的被採用**（沒有另外開一個新題組）',
    appendCommit.body?.questionGroupId === createdGroupIds[0],
    `${appendCommit.body?.questionGroupId} vs ${createdGroupIds[0]}`);
  check('既有題組的題數增加', appendCommit.body?.committedCount === 1);

  const cannotMerge = await upload('/imports', 'merge.json', {
    schemaVersion: '1.2.0',
    subject: { name: `多題組測試科目-${stamp}` },
    questionGroups: [
      { name: '併組甲', chapter: { name: `併組甲-${stamp}` },
        questions: [validQuestion(1, { externalId: `E2E-${stamp}-MERGE-A` })] },
      { name: '併組乙', chapter: { name: `併組乙-${stamp}` },
        questions: [validQuestion(1, { externalId: `E2E-${stamp}-MERGE-B` })] },
    ],
  }, csrf);
  const mergeCommit = await call('POST', `/imports/${cannotMerge.body.id}/commit`,
    { targetGroupId: createdGroupIds[0] }, H());
  check('**多個題組不可以全部併進同一個既有題組**（章節會被默默丟掉）',
    mergeCommit.status >= 400, `status=${mergeCommit.status}`);

  console.log('\n=== 多題組：科目不一致要擋下 ===');
  const subjectMismatch = await uploadMany('/imports', [
    { filename: 'a.json', content: chapterFile('混科第一章', [
      validQuestion(1, { externalId: `E2E-${stamp}-MX-A` })]) },
    { filename: 'b.json', content: {
      ...chapterFile('混科第二章', [validQuestion(1, { externalId: `E2E-${stamp}-MX-B` })]),
      subject: { name: '另一個完全不同的科目' },
    } },
  ], csrf);
  check('**各檔科目不一致 → 批次標為 failed**', subjectMismatch.body?.status === 'failed',
    `status=${subjectMismatch.body?.status}`);
  check('錯誤碼為 SUBJECT_MISMATCH_ACROSS_FILES',
    (subjectMismatch.body?.fileIssues ?? []).some((i) => i.code === 'SUBJECT_MISMATCH_ACROSS_FILES'),
    JSON.stringify(subjectMismatch.body?.fileIssues));
  const mismatchCommit = await call('POST', `/imports/${subjectMismatch.body.id}/commit`, {}, H());
  check('**科目不一致的批次不可 commit**（否則不知道要匯到哪個科目）',
    mismatchCommit.status >= 400, `status=${mismatchCommit.status}`);

  console.log('\n=== 多題組：單一檔案內含多個題組（1.2.0）===');
  const nested = await upload('/imports', 'nested.json', {
    schemaVersion: '1.2.0',
    subject: { name: `多題組測試科目-${stamp}` },
    questionGroups: [
      {
        name: `巢狀第一組-${stamp}`,
        chapter: { name: `巢狀第一章-${stamp}` },
        notes: [{ noteId: 'N1', title: '第一章重點', content: '行政處分須對外直接發生法律效果。' }],
        questions: [validQuestion(1, {
          externalId: `E2E-${stamp}-NS-A1`, questionNumber: 1, relatedNoteIds: ['N1'] })],
      },
      {
        name: `巢狀第二組-${stamp}`,
        chapter: { name: `巢狀第二章-${stamp}` },
        questions: [validQuestion(1, { externalId: `E2E-${stamp}-NS-B1`, questionNumber: 1 })],
      },
    ],
  }, csrf);
  check('1.2.0 單檔多題組上傳成功', nested.status === 201,
    `status=${nested.status} ${JSON.stringify(nested.body).slice(0, 200)}`);
  check('拆出兩個題組', nested.body?.groups?.length === 2, `groups=${nested.body?.groups?.length}`);
  check('無錯誤', nested.body?.errorCount === 0, `errorCount=${nested.body?.errorCount}`);
  check('**筆記掛在自己的題組上**',
    nested.body?.groups?.[0]?.noteCount === 1 && nested.body?.groups?.[1]?.noteCount === 0,
    JSON.stringify(nested.body?.groups?.map((g) => g.noteCount)));

  const nestedCommit = await call('POST', `/imports/${nested.body.id}/commit`, {}, H());
  check('1.2.0 可以 commit', nestedCommit.status === 200 || nestedCommit.status === 201,
    `status=${nestedCommit.status}`);
  check('兩題都寫入', nestedCommit.body?.committedCount === 2,
    `committed=${nestedCommit.body?.committedCount}`);

  console.log('\n=== 多題組：沒錯的先匯，有錯的擋下 ===');
  // 第二組缺正確答案 → 該組有阻斷性錯誤；第一組完好。
  const partial = await uploadMany('/imports', [
    { filename: 'good.json', content: chapterFile('部分第一章', [
      validQuestion(1, { externalId: `E2E-${stamp}-PT-A1`, questionNumber: 1 }),
      validQuestion(2, { externalId: `E2E-${stamp}-PT-A2`, questionNumber: 2 }),
    ]) },
    { filename: 'bad.json', content: chapterFile('部分第二章', [
      validQuestion(1, { externalId: `E2E-${stamp}-PT-B1`, questionNumber: 1, correctAnswers: [] }),
    ]) },
  ], csrf);
  check('部分有錯的批次仍可建立', partial.status === 201, `status=${partial.status}`);
  check('偵測到 1 筆錯誤', partial.body?.errorCount === 1, `errorCount=${partial.body?.errorCount}`);
  check('**好的題組 canCommit，壞的不行**',
    partial.body?.groups?.[0]?.canCommit === true && partial.body?.groups?.[1]?.canCommit === false,
    JSON.stringify(partial.body?.groups?.map((g) => g.canCommit)));

  const partialCommit = await call('POST', `/imports/${partial.body.id}/commit`, {}, H());
  check('**有錯也能 commit**（沒錯的先匯）',
    partialCommit.status === 200 || partialCommit.status === 201,
    `status=${partialCommit.status} ${JSON.stringify(partialCommit.body).slice(0, 200)}`);
  check('只寫入好的那組的 2 題', partialCommit.body?.committedCount === 2,
    `committed=${partialCommit.body?.committedCount}`);
  check('**壞的題組被標為 skipped**', partialCommit.body?.groups?.[1]?.skipped === true,
    JSON.stringify(partialCommit.body?.groups));
  check('逐組題數加總等於整批題數',
    (partialCommit.body?.groups ?? []).reduce((sum, g) => sum + g.committedCount, 0) ===
      partialCommit.body?.committedCount);

  const partialAfter = await call('GET', `/imports/${partial.body.id}`);
  check('**批次維持 partially_valid**（否則剩下那組再也匯不進來）',
    partialAfter.body?.status === 'partially_valid', `status=${partialAfter.body?.status}`);

  const badChapter = (await listChapters()).find((c) => c.name === `部分第二章-${stamp}`);
  check('**被擋下的題組完全沒有落地**（連空題組都不該建立）', badChapter === undefined,
    `chapter=${badChapter?.id}`);

  console.log('\n=== 多題組：修好之後補匯剩下的題組 ===');
  const partialRows = await call('GET', `/imports/${partial.body.id}/questions`);
  const brokenRow = (partialRows.body ?? []).find((r) => r.externalId === `E2E-${stamp}-PT-B1`);
  check('找得到出錯的那一列', Boolean(brokenRow));

  if (brokenRow) {
    // 修正介面吃的是帶 isCorrect 的完整 options，不是 correctAnswers。
    const fixed = await call('PATCH',
      `/imports/${partial.body.id}/questions/${brokenRow.id}`,
      {
        options: [
          { key: 'A', text: '行政指導', isCorrect: false },
          { key: 'B', text: '拆除命令', isCorrect: true },
          { key: 'C', text: '行政計畫', isCorrect: false },
          { key: 'D', text: '行政契約', isCorrect: false },
        ],
      }, H());
    check('可以修正出錯的列', fixed.status === 200, `status=${fixed.status}`);

    const revalidated = await call('POST', `/imports/${partial.body.id}/revalidate`, {}, H());
    check('重新驗證後沒有錯誤', revalidated.body?.errorCount === 0,
      `errorCount=${revalidated.body?.errorCount}`);
    check('**重新驗證不會把題組打散**', revalidated.body?.groups?.length === 2,
      `groups=${revalidated.body?.groups?.length}`);

    const recommit = await call('POST', `/imports/${partial.body.id}/commit`, {}, H());
    check('可以補匯剩下的題組', recommit.status === 200 || recommit.status === 201,
      `status=${recommit.status} ${JSON.stringify(recommit.body).slice(0, 200)}`);
    check('這次只寫入剩下的 1 題', recommit.body?.committedCount === 1,
      `committed=${recommit.body?.committedCount}`);
    check('**已匯過的題組不會重複寫入**',
      recommit.body?.groups?.[0]?.alreadyCommitted === true &&
        recommit.body?.groups?.[0]?.committedCount === 0,
      JSON.stringify(recommit.body?.groups));
    check('**逐組題數加總等於整批題數**（committedCount 是本次而非累計）',
      (recommit.body?.groups ?? []).reduce((sum, g) => sum + g.committedCount, 0) ===
        recommit.body?.committedCount,
      JSON.stringify(recommit.body?.groups));

    const finalBatch = await call('GET', `/imports/${partial.body.id}`);
    check('全部匯完後批次為 committed', finalBatch.body?.status === 'committed',
      `status=${finalBatch.body?.status}`);

    const fixedChapter = (await listChapters()).find((c) => c.name === `部分第二章-${stamp}`);
    check('修好的題組這時才落地', Boolean(fixedChapter));
    if (fixedChapter) {
      const inFixed = await call('GET', `/questions?chapterId=${fixedChapter.id}&pageSize=50`);
      check('補匯的那題確實在庫裡', inFixed.body?.pagination?.total === 1,
        `total=${inFixed.body?.pagination?.total}`);
    }
  }

  console.log(`\n===== 通過 ${pass} 項，失敗 ${fail} 項 =====`);
  process.exit(fail === 0 ? 0 : 1);
};

run().catch((e) => { console.error('測試執行失敗：', e); process.exit(1); });
