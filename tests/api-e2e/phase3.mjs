/**
 * Phase 3 端到端驗證：受控標籤系統。
 *
 * 以 Node fetch 執行，避免 shell 字碼頁轉換污染中文測試資料。
 * 需先啟動後端；預設打 :4000，可用 BASE 覆寫。
 *
 * 最關鍵的兩組斷言：
 *   1. 合併標籤時關聯必須完整轉移，一筆都不能掉（FR-TAG-10），
 *      包含「兩邊都掛了同一題」這個會撞主鍵與部分唯一索引的情境。
 *   2. AI 不可能繞過審核建立正式標籤（FR-TAG-06／§22 之 12）——
 *      系統中不存在「由名稱直接建立標籤」的端點。
 */
// 預設打測試後端（:4101）而非開發後端（:4000）：這些腳本會實際建立科目、
// 題目與作答紀錄，誤打到正式資料庫會污染真實題庫。要換目標請設 BASE。
const BASE = process.env.BASE ?? 'http://localhost:4101/api/v1';

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

function check(label, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ✔ ${label}`); }
  else { fail += 1; console.log(`  ✘ ${label} ${detail}`); }
}

let csrf = '';
const H = () => ({ 'X-CSRF-Token': csrf });
async function refreshCsrf() {
  csrf = (await call('GET', '/auth/csrf')).body.csrfToken;
}

const question = (n, groupId) => ({
  questionGroupId: groupId,
  questionNumber: n,
  type: 'single_choice',
  stem: `第 ${n} 題：下列何者屬於行政處分？`,
  options: [
    { key: 'A', text: '行政指導', isCorrect: false },
    { key: 'B', text: '拆除命令', isCorrect: true },
    { key: 'C', text: '行政計畫', isCorrect: false },
    { key: 'D', text: '行政契約', isCorrect: false },
  ],
  explanation: null,
  reviewRequired: false,
});

const run = async () => {
  console.log('\n=== 準備：登入與建立題庫 ===');
  await refreshCsrf();
  const status = await call('GET', '/auth/bootstrap');
  if (status.body.canBootstrap) {
    await call('POST', '/auth/bootstrap',
      { username: 'probe', password: 'probe-password-123', confirmPassword: 'probe-password-123' }, H());
  } else {
    await call('POST', '/auth/login', { username: 'probe', password: 'probe-password-123' }, H());
  }
  check('已登入', (await call('GET', '/auth/me')).status === 200);

  const stamp = Date.now() % 1000000;
  // 標籤名稱一律加上本次執行的識別碼，讓腳本不依賴資料庫初始狀態、可重複執行。
  const T = (name) => `${name}${stamp}`;
  const subject = await call('POST', '/subjects', { name: `標籤測試科目 ${stamp}` }, H());
  const group = await call('POST', '/question-groups',
    { subjectId: subject.body.id, name: '標籤測試題組' }, H());
  const q = [];
  for (let n = 1; n <= 4; n += 1) {
    const created = await call('POST', '/questions', question(n, group.body.id), H());
    q.push(created.body);
  }
  check('建立 4 題測試題目', q.every((item) => item?.id), JSON.stringify(q[0])?.slice(0, 120));

  console.log('\n=== 種子資料（FR-TAG-04、FR-TAG-05）===');
  const skills = await call('GET', '/skill-tags');
  check('能力類型預設 6 種', skills.body.length === 6, `n=${skills.body.length}`);
  check('能力類型名稱符合規格',
    ['概念辨識', '條件判斷', '規則適用', '案例推理', '例外規則辨識', '資料判讀']
      .every((name) => skills.body.some((s) => s.name === name)),
    skills.body.map((s) => s.name).join('、'));

  const errorTypes = await call('GET', '/error-types');
  check('錯誤類型預設 8 種', errorTypes.body.length === 8, `n=${errorTypes.body.length}`);
  const fallbacks = errorTypes.body.filter((t) => t.isFallback);
  check('有且只有一個 fallback「無法判定」',
    fallbacks.length === 1 && fallbacks[0].name === '無法判定',
    JSON.stringify(fallbacks.map((f) => f.name)));

  const fallbackId = fallbacks[0].id;
  const disableFallback = await call('PATCH', `/error-types/${fallbackId}`, { status: 'deprecated' }, H());
  check('fallback 不可停用（否則 AI 會被迫亂猜錯因）',
    disableFallback.status === 409, `status=${disableFallback.status}`);

  const addErrorType = await call('POST', '/error-types', { name: '亂猜' }, H());
  check('錯誤類型不接受新增（保持可比較性）',
    addErrorType.status === 404 || addErrorType.status === 405, `status=${addErrorType.status}`);

  console.log('\n=== 知識點與正規化 ===');
  const tagA = await call('POST', '/knowledge-tags', { name: T('行政處分') }, H());
  check('建立知識點', tagA.status === 201, JSON.stringify(tagA.body)?.slice(0, 150));
  check('slug 為正規化後的名稱', tagA.body?.slug === T('行政處分'), tagA.body?.slug);

  // 同一個名稱、只差在空白：正規化後應視為同一個標籤。
  const dupSpaced = await call('POST', '/knowledge-tags', { name: ` 行政 處分 ${stamp} ` }, H());
  check('去空白後同名 → 409 TAG_NAME_DUPLICATED',
    dupSpaced.status === 409 && dupSpaced.body.error.code === 'TAG_NAME_DUPLICATED',
    `status=${dupSpaced.status}`);

  const fullWidth = await call('POST', '/knowledge-tags', { name: T('ＲＯＥ 分析') }, H());
  check('全形名稱可建立', fullWidth.status === 201);
  check('全形轉半形、英文轉小寫後成為 slug', fullWidth.body?.slug === T('roe分析'), fullWidth.body?.slug);

  const dupHalfWidth = await call('POST', '/knowledge-tags', { name: T('roe分析') }, H());
  check('半形小寫同名 → 409（全形半形已收斂）', dupHalfWidth.status === 409, `status=${dupHalfWidth.status}`);

  const tagB = await call('POST', '/knowledge-tags', { name: T('行政契約') }, H());
  check('不同名稱可正常建立', tagB.status === 201);

  console.log('\n=== 別名（FR-TAG-09）===');
  const alias = await call('POST', '/tag-aliases',
    { tagKind: 'knowledge', alias: T('行政處份'), canonicalTagId: tagA.body.id }, H());
  check('建立別名（錯字寫法）', alias.status === 201, JSON.stringify(alias.body)?.slice(0, 150));

  const resolved = await call('GET',
    `/tag-resolve?tagKind=knowledge&name=${encodeURIComponent(T('行政處份'))}`);
  check('別名可解析回正式標籤',
    resolved.body?.matchedTagId === tagA.body.id && resolved.body?.matchedVia === 'alias',
    JSON.stringify(resolved.body));

  const resolvedByName = await call('GET',
    `/tag-resolve?tagKind=knowledge&name=${encodeURIComponent(T('行政 處分'))}`);
  check('本名（含空白）可直接解析', resolvedByName.body?.matchedVia === 'name');

  const unknown = await call('GET',
    `/tag-resolve?tagKind=knowledge&name=${encodeURIComponent(T('完全沒見過的東西'))}`);
  check('未知名稱解析為 null（只能走建議流程）', unknown.body?.matchedTagId === null);

  const aliasConflict = await call('POST', '/tag-aliases',
    { tagKind: 'knowledge', alias: T('行政契約'), canonicalTagId: tagA.body.id }, H());
  check('別名不可與其他標籤本名衝突 → 409', aliasConflict.status === 409, `status=${aliasConflict.status}`);

  console.log('\n=== 題目標籤：主要 1 個、次要最多 2 個 ===');
  const tagC = await call('POST', '/knowledge-tags', { name: T('信賴保護原則') }, H());
  const tagD = await call('POST', '/knowledge-tags', { name: T('比例原則') }, H());

  const setTags = await call('PUT', `/questions/${q[0].id}/tags`, {
    primaryKnowledgeTagId: tagA.body.id,
    secondaryKnowledgeTagIds: [tagB.body.id, tagC.body.id],
    primarySkillTagId: skills.body[0].id,
    secondarySkillTagIds: [],
  }, H());
  check('設定標籤成功', setTags.status === 200, JSON.stringify(setTags.body)?.slice(0, 200));
  check('主要知識點 1 個',
    setTags.body.knowledgeTags.filter((t) => t.role === 'primary').length === 1);
  check('次要知識點 2 個',
    setTags.body.knowledgeTags.filter((t) => t.role === 'secondary').length === 2);
  check('主要標籤排在前面', setTags.body.knowledgeTags[0].role === 'primary');

  const tooMany = await call('PUT', `/questions/${q[0].id}/tags`, {
    primaryKnowledgeTagId: tagA.body.id,
    secondaryKnowledgeTagIds: [tagB.body.id, tagC.body.id, tagD.body.id],
    secondarySkillTagIds: [],
  }, H());
  check('次要知識點 3 個 → 400（契約層擋下）', tooMany.status === 400, `status=${tooMany.status}`);

  const dupRole = await call('PUT', `/questions/${q[0].id}/tags`, {
    primaryKnowledgeTagId: tagA.body.id,
    secondaryKnowledgeTagIds: [tagA.body.id],
    secondarySkillTagIds: [],
  }, H());
  check('同一標籤同時當主要與次要 → 400', dupRole.status === 400, `status=${dupRole.status}`);

  const versionBefore = q[0].currentVersion;
  const afterTagging = await call('GET', `/questions/${q[0].id}`);
  check('設定標籤不會遞增題目版本',
    afterTagging.body.currentVersion === versionBefore,
    `${afterTagging.body.currentVersion} vs ${versionBefore}`);
  check('設定標籤不會改變 contentHash',
    afterTagging.body.contentHash === q[0].contentHash);
  check('題目回應帶出標籤', afterTagging.body.knowledgeTags.length === 3);

  const deprecated = await call('POST', `/knowledge-tags/${tagD.body.id}/deprecate`, undefined, H());
  check('停用知識點', deprecated.body?.status === 'deprecated');
  const useDeprecated = await call('PUT', `/questions/${q[1].id}/tags`, {
    primaryKnowledgeTagId: tagD.body.id,
    secondaryKnowledgeTagIds: [],
    secondarySkillTagIds: [],
  }, H());
  check('已停用的標籤不可再掛到題目上 → 409', useDeprecated.status === 409, `status=${useDeprecated.status}`);
  await call('POST', `/knowledge-tags/${tagD.body.id}/activate`, undefined, H());

  console.log('\n=== 依知識點篩選與出題（FR-QUIZ-06）===');
  await call('PUT', `/questions/${q[1].id}/tags`, {
    primaryKnowledgeTagId: tagA.body.id, secondaryKnowledgeTagIds: [], secondarySkillTagIds: [],
  }, H());
  await call('PUT', `/questions/${q[2].id}/tags`, {
    primaryKnowledgeTagId: tagB.body.id, secondaryKnowledgeTagIds: [], secondarySkillTagIds: [],
  }, H());

  const filtered = await call('GET', `/questions?knowledgeTagId=${tagA.body.id}&pageSize=50`);
  check('題目列表可依知識點篩選（第 1、2 題掛 A）',
    filtered.body.pagination.total === 2, `total=${filtered.body.pagination.total}`);

  const untagged = await call('GET', `/questions?questionGroupId=${group.body.id}&knowledgeTagId=none&pageSize=50`);
  check('可篩選出完全沒有知識點的題目（第 4 題）',
    untagged.body.pagination.total === 1, `total=${untagged.body.pagination.total}`);

  const tagQuiz = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'knowledge_tag', refId: tagA.body.id }] }, H());
  check('可只作答特定知識點 → 2 題',
    tagQuiz.body?.totalQuestions === 2, `n=${tagQuiz.body?.totalQuestions}`);
  check('場次記錄了 knowledge_tag 範圍與名稱',
    tagQuiz.body?.scopes?.[0]?.scopeType === 'knowledge_tag' &&
    tagQuiz.body?.scopes?.[0]?.refName === T('行政處分'),
    JSON.stringify(tagQuiz.body?.scopes));

  const badTagScope = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'knowledge_tag', refId: '00000000-0000-4000-8000-000000000000' }] }, H());
  check('不存在的知識點 → 404 TAG_NOT_FOUND',
    badTagScope.status === 404 && badTagScope.body.error.code === 'TAG_NOT_FOUND',
    `status=${badTagScope.status}`);

  console.log('\n=== 合併：關聯必須完整轉移（FR-TAG-10）===');
  // 第 1 題同時掛了 A（主要）與 B（次要）—— 合併 B→A 會撞主鍵，是最容易寫錯的情境。
  // 第 3 題只掛 B（主要）—— 合併後應直接改指向 A。
  const beforeA = await call('GET', `/questions?knowledgeTagId=${tagA.body.id}&pageSize=50`);
  const beforeB = await call('GET', `/questions?knowledgeTagId=${tagB.body.id}&pageSize=50`);
  check('合併前：A 有 2 題、B 有 2 題',
    beforeA.body.pagination.total === 2 && beforeB.body.pagination.total === 2,
    `A=${beforeA.body.pagination.total} B=${beforeB.body.pagination.total}`);

  const merged = await call('POST', `/knowledge-tags/${tagB.body.id}/merge`,
    { targetTagId: tagA.body.id }, H());
  check('合併成功並回傳目標標籤', merged.status === 200 && merged.body.id === tagA.body.id);

  const afterA = await call('GET', `/questions?knowledgeTagId=${tagA.body.id}&pageSize=50`);
  check('合併後 A 涵蓋原本兩邊的題目（1、2、3 題）',
    afterA.body.pagination.total === 3, `total=${afterA.body.pagination.total}`);

  const afterB = await call('GET', `/questions?knowledgeTagId=${tagB.body.id}&pageSize=50`);
  check('合併後 B 不再有任何題目', afterB.body.pagination.total === 0, `total=${afterB.body.pagination.total}`);

  const q1Tags = await call('GET', `/questions/${q[0].id}/tags`);
  check('原本同時掛 A(主) 與 B(次) 的題目，合併後只剩一筆 A',
    q1Tags.body.knowledgeTags.filter((t) => t.id === tagA.body.id).length === 1,
    JSON.stringify(q1Tags.body.knowledgeTags));
  check('且角色保留為主要（primary 優先）',
    q1Tags.body.knowledgeTags.find((t) => t.id === tagA.body.id)?.role === 'primary');
  check('該題標籤總數由 3 減為 2（B 併入 A，C 不變）',
    q1Tags.body.knowledgeTags.length === 2, JSON.stringify(q1Tags.body.knowledgeTags));

  const q3Tags = await call('GET', `/questions/${q[2].id}/tags`);
  check('原本只掛 B 的題目，合併後改掛 A 且保留主要角色',
    q3Tags.body.knowledgeTags.length === 1 &&
    q3Tags.body.knowledgeTags[0].id === tagA.body.id &&
    q3Tags.body.knowledgeTags[0].role === 'primary',
    JSON.stringify(q3Tags.body.knowledgeTags));

  const mergedTag = await call('GET', `/knowledge-tags/${tagB.body.id}`);
  check('來源標籤標記為 merged 並指向目標',
    mergedTag.body.status === 'merged' && mergedTag.body.mergedIntoId === tagA.body.id,
    JSON.stringify({ s: mergedTag.body.status, m: mergedTag.body.mergedIntoId }));
  check('來源標籤沒有被刪除（資料保留）', mergedTag.status === 200);

  const aliasAfterMerge = await call('GET',
    `/tag-resolve?tagKind=knowledge&name=${encodeURIComponent(T('行政契約'))}`);
  check('來源名稱自動成為目標的別名',
    aliasAfterMerge.body?.matchedTagId === tagA.body.id && aliasAfterMerge.body?.matchedVia === 'alias',
    JSON.stringify(aliasAfterMerge.body));

  const listAfterMerge = await call('GET', '/knowledge-tags?pageSize=100');
  check('列表預設不顯示已合併的標籤',
    !listAfterMerge.body.items.some((t) => t.id === tagB.body.id));

  const mergeSelf = await call('POST', `/knowledge-tags/${tagA.body.id}/merge`,
    { targetTagId: tagA.body.id }, H());
  check('合併到自己 → 409 TAG_MERGE_INVALID_TARGET',
    mergeSelf.status === 409 && mergeSelf.body.error.code === 'TAG_MERGE_INVALID_TARGET');

  const mergeIntoMerged = await call('POST', `/knowledge-tags/${tagC.body.id}/merge`,
    { targetTagId: tagB.body.id }, H());
  check('合併到已被合併的標籤 → 409', mergeIntoMerged.status === 409, `status=${mergeIntoMerged.status}`);

  console.log('\n=== 刪除保護 ===');
  const deleteUsed = await call('DELETE', `/knowledge-tags/${tagA.body.id}`, undefined, H());
  check('已被使用的標籤不可直接刪除 → 409', deleteUsed.status === 409, `status=${deleteUsed.status}`);

  const unusedTag = await call('POST', '/knowledge-tags', { name: `沒用到的標籤 ${stamp}` }, H());
  const deleteUnused = await call('DELETE', `/knowledge-tags/${unusedTag.body.id}`, undefined, H());
  check('沒被使用的標籤可以刪除', deleteUnused.status === 200, `status=${deleteUnused.status}`);

  console.log('\n=== 標籤建議審核（FR-TAG-07、§22 之 12）===');
  const suggestion = await call('POST', '/tag-suggestions',
    { tagKind: 'knowledge', suggestedName: T('裁量瑕疵'), rationale: 'AI 在分析第 1 題時提到這個概念' }, H());
  check('提交建議', suggestion.status === 201, JSON.stringify(suggestion.body)?.slice(0, 150));
  check('建議初始狀態為 pending', suggestion.body?.status === 'pending');

  const beforeApprove = await call('GET',
    `/tag-resolve?tagKind=knowledge&name=${encodeURIComponent(T('裁量瑕疵'))}`);
  check('**審核前該名稱不存在於正式標籤中**（AI 無法繞過審核）',
    beforeApprove.body?.matchedTagId === null, JSON.stringify(beforeApprove.body));

  const dupSuggestion = await call('POST', '/tag-suggestions',
    { tagKind: 'knowledge', suggestedName: T('裁量瑕疵') }, H());
  check('重複提交同一名稱 → 累加次數而非產生新列',
    dupSuggestion.body?.occurrenceCount === 2, `n=${dupSuggestion.body?.occurrenceCount}`);

  const existingSuggestion = await call('POST', '/tag-suggestions',
    { tagKind: 'knowledge', suggestedName: T('行政處分') }, H());
  check('已對應到既有標籤的名稱不接受建議 → 409',
    existingSuggestion.status === 409, `status=${existingSuggestion.status}`);

  const approved = await call('POST', `/tag-suggestions/${suggestion.body.id}/approve`, {}, H());
  check('核准建議', approved.status === 200 && approved.body.status === 'approved',
    JSON.stringify(approved.body)?.slice(0, 150));
  check('核准後產生正式標籤並記錄對應', approved.body.resolvedTagId !== null);

  const afterApprove = await call('GET',
    `/tag-resolve?tagKind=knowledge&name=${encodeURIComponent(T('裁量瑕疵'))}`);
  check('審核後名稱才解析得到正式標籤',
    afterApprove.body?.matchedTagId === approved.body.resolvedTagId);

  const reApprove = await call('POST', `/tag-suggestions/${suggestion.body.id}/approve`, {}, H());
  check('已處理的建議不可重複裁決 → 409', reApprove.status === 409, `status=${reApprove.status}`);

  // 併入：改名情境
  const s2 = await call('POST', '/tag-suggestions',
    { tagKind: 'knowledge', suggestedName: T('行政處分概念') }, H());
  const mergedSuggestion = await call('POST', `/tag-suggestions/${s2.body.id}/merge`,
    { targetTagId: tagA.body.id, reviewNote: '與既有標籤重複' }, H());
  check('併入既有標籤', mergedSuggestion.body?.status === 'merged');
  const s2Resolve = await call('GET',
    `/tag-resolve?tagKind=knowledge&name=${encodeURIComponent(T('行政處分概念'))}`);
  check('併入後自動建立別名，同名不會再變成建議',
    s2Resolve.body?.matchedTagId === tagA.body.id && s2Resolve.body?.matchedVia === 'alias');

  const s3 = await call('POST', '/tag-suggestions',
    { tagKind: 'knowledge', suggestedName: T('不需要的標籤') }, H());
  const rejected = await call('POST', `/tag-suggestions/${s3.body.id}/reject`,
    { reviewNote: '太籠統' }, H());
  check('退回建議', rejected.body?.status === 'rejected');
  check('退回會保留理由', rejected.body?.reviewNote === '太籠統');
  const s3Resolve = await call('GET',
    `/tag-resolve?tagKind=knowledge&name=${encodeURIComponent(T('不需要的標籤'))}`);
  check('退回的建議不會建立任何標籤', s3Resolve.body?.matchedTagId === null);

  const errorTypeSuggestion = await call('POST', '/tag-suggestions',
    { tagKind: 'error_type', suggestedName: T('粗心') }, H());
  const approveErrorType = await call('POST',
    `/tag-suggestions/${errorTypeSuggestion.body.id}/approve`, {}, H());
  check('錯誤類型的建議不可核准新增 → 409',
    approveErrorType.status === 409, `status=${approveErrorType.status}`);

  console.log('\n=== 錯題本的標籤篩選（FR-MIS-02）===');
  const quiz = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'question_group', refId: group.body.id }] }, H());
  const first = await call('GET', `/quiz-sessions/${quiz.body.id}/questions/1`);
  await call('POST', `/quiz-sessions/${quiz.body.id}/answers`,
    { sessionQuestionId: first.body.sessionQuestionId, selectedAnswers: ['A'] }, H());
  check('先製造一筆錯題', (await call('GET', `/mistakes/${first.body.questionId}`)).status === 200);

  const byTag = await call('GET', `/mistakes?knowledgeTagId=${tagA.body.id}&pageSize=50`);
  check('錯題本可依知識點篩選', byTag.status === 200 && byTag.body.pagination.total >= 1,
    `total=${byTag.body.pagination.total}`);

  const conceptType = errorTypes.body.find((t) => t.name === '概念混淆');
  // 基準值先取，後續一律用「增量」斷言 —— 用絕對數字會讓腳本無法重複執行。
  const beforeFilter = await call('GET', `/mistakes?errorTypeId=${conceptType.id}&pageSize=50`);
  const beforeUsage = errorTypes.body.find((t) => t.id === conceptType.id).usageCount;

  const setErrorTypes = await call('PUT', `/mistakes/${first.body.questionId}/error-types`,
    { errorTypeIds: [conceptType.id] }, H());
  check('可標記錯題的錯誤類型', setErrorTypes.status === 200, `status=${setErrorTypes.status}`);

  const mistakeDetail = await call('GET', `/mistakes/${first.body.questionId}`);
  check('錯題詳情帶出錯誤類型',
    mistakeDetail.body.errorTypes.some((t) => t.errorTypeId === conceptType.id),
    JSON.stringify(mistakeDetail.body.errorTypes));
  check('錯題詳情帶出知識點', Array.isArray(mistakeDetail.body.knowledgeTags));

  const byErrorType = await call('GET', `/mistakes?errorTypeId=${conceptType.id}&pageSize=50`);
  check('錯題本可依錯誤類型篩選，且剛標記的那題確實出現在結果中',
    byErrorType.body.pagination.total === beforeFilter.body.pagination.total + 1 &&
    byErrorType.body.items.some((m) => m.questionId === first.body.questionId),
    `${byErrorType.body.pagination.total} vs ${beforeFilter.body.pagination.total}+1`);

  const otherType = errorTypes.body.find((t) => t.name === '記憶錯誤');
  const byOtherType = await call('GET', `/mistakes?errorTypeId=${otherType.id}&pageSize=50`);
  check('未標記的錯誤類型篩不到這一題',
    !byOtherType.body.items.some((m) => m.questionId === first.body.questionId));

  const errorTypeUsage = await call('GET', '/error-types');
  check('錯誤類型的使用次數 +1',
    errorTypeUsage.body.find((t) => t.id === conceptType.id).usageCount === beforeUsage + 1,
    `${errorTypeUsage.body.find((t) => t.id === conceptType.id).usageCount} vs ${beforeUsage}+1`);

  console.log('\n=== 種子資料冪等性 ===');
  const skillsAgain = await call('GET', '/skill-tags?includeDeprecated=true');
  check('重啟後不會重複插入種子（仍是 6 種）',
    skillsAgain.body.length >= 6 && skillsAgain.body.filter((s) => s.name === '概念辨識').length === 1,
    `n=${skillsAgain.body.length}`);

  console.log(`\n=== Phase 3 結果：${pass} 通過、${fail} 失敗 ===\n`);
  process.exit(fail === 0 ? 0 : 1);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
