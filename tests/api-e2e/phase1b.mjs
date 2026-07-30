/**
 * Phase 1b 端到端驗證：題目 CRUD 與 JSON 匯入。
 *
 * 以 Node fetch 執行，避免 shell 字碼頁轉換污染中文測試資料。
 * 需先啟動後端；預設打 :4000，可用 BASE 覆寫。
 */
const BASE = process.env.BASE ?? 'http://localhost:4000/api/v1';

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
  externalId: `E2E-${n}`,
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
  questionGroup: { name: '匯入測試題組', source: '單元測試', year: 2026 },
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
  const noExplanation = imported.body.items.find((q) => q.externalId === 'E2E-101');
  check('沒有解析的題目 explanation 仍為 null（未被編造）', noExplanation?.explanation === null);
  const withReview = imported.body.items.find((q) => q.externalId === 'E2E-103');
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

  console.log(`\n===== 通過 ${pass} 項，失敗 ${fail} 項 =====`);
  process.exit(fail === 0 ? 0 : 1);
};

run().catch((e) => { console.error('測試執行失敗：', e); process.exit(1); });
