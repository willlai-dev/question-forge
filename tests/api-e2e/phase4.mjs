/**
 * Phase 4 端到端驗證：AI 三階段分析、答案爭議、用量記錄。
 *
 * **必須以 Mock provider 執行**（AI_PROVIDER=mock、SEARCH_PROVIDER=mock）：
 * 真實模型的輸出不可重現，且每跑一次測試就消耗一次免費額度。
 * Mock 是正式的 provider 實作，走的是與真實 provider 完全相同的
 * Gateway、驗證、保存路徑 —— 被替換掉的只有最外層的 HTTP 呼叫。
 *
 * 需先啟動後端與 Redis；預設打 :4000，可用 BASE 覆寫。
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

function check(label, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ✔ ${label}`); }
  else { fail += 1; console.log(`  ✘ ${label} ${detail}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let csrf = '';
const H = () => ({ 'X-CSRF-Token': csrf });
async function refreshCsrf() {
  csrf = (await call('GET', '/auth/csrf')).body.csrfToken;
}

/** 等任務結束。逾時就回傳最後看到的狀態，讓失敗訊息帶得出診斷資訊。 */
async function waitForJob(jobId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    await sleep(300);
    last = (await call('GET', `/ai/jobs/${jobId}`)).body;
    if (['completed', 'failed', 'cancelled'].includes(last.status)) return last;
  }
  return last;
}

const run = async () => {
  console.log('\n=== 準備 ===');
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
  const subject = await call('POST', '/subjects', { name: `AI測試科目${stamp}` }, H());
  const group = await call('POST', '/question-groups',
    { subjectId: subject.body.id, name: 'AI測試題組' }, H());
  const tag = await call('POST', '/knowledge-tags', { name: `AI測試知識點${stamp}` }, H());
  check('建立測試題庫與知識點', subject.status === 201 && group.status === 201 && tag.status === 201);

  const makeQuestion = async (n) =>
    call('POST', '/questions', {
      questionGroupId: group.body.id,
      questionNumber: n,
      type: 'single_choice',
      stem: `第 ${n} 題：下列何者屬於行政處分？`,
      options: [
        { key: 'A', text: '拆除命令', isCorrect: true },
        { key: 'B', text: '行政指導', isCorrect: false },
        { key: 'C', text: '行政計畫', isCorrect: false },
      ],
      explanation: null,
      reviewRequired: false,
    }, H());

  const q1 = (await makeQuestion(1)).body;
  const q2 = (await makeQuestion(2)).body;
  check('建立測試題目', Boolean(q1?.id && q2?.id));

  console.log('\n=== 三階段分析（驗收 #13）===');
  const usageBefore = (await call('GET', '/ai/usage')).body.totalCalls;

  const start = await call('POST', `/ai/questions/${q1.id}/analyze`, { force: false }, H());
  check('啟動分析 → 202', start.status === 202, `status=${start.status}`);
  check('回傳 jobId 而非同步等待', typeof start.body?.id === 'string');
  check('初始狀態為 pending', start.body?.status === 'pending');
  check('初始進度為 QUEUED', start.body?.progressStep === 'QUEUED');

  const done = await waitForJob(start.body.id);
  check('任務完成', done.status === 'completed',
    `status=${done.status} err=${done.errorCode} ${String(done.errorMessage).slice(0, 200)}`);
  check('完成時進度為 100%', done.progressPct === 100);

  const usageAfter = (await call('GET', '/ai/usage')).body.totalCalls;
  check('一次分析剛好 3 次模型呼叫（規格上限）',
    usageAfter - usageBefore === 3, `${usageBefore} → ${usageAfter}`);

  console.log('\n=== 分析結果與引用（驗收 #15、#16）===');
  const analysis = await call('GET', `/questions/${q1.id}/analysis`);
  check('可取得解析', analysis.status === 200, `status=${analysis.status}`);
  check('有核心概念與解題步驟',
    Boolean(analysis.body?.coreConcept) && analysis.body?.solutionSteps.length > 0);
  check('每個選項都有分析（不多不少）',
    analysis.body?.optionAnalysis.length === 3,
    `n=${analysis.body?.optionAnalysis.length}`);
  check('解析尚未過期（isStale = false）', analysis.body?.isStale === false);

  const sources = analysis.body?.sources ?? [];
  check('有保存查證來源', sources.length > 0, `n=${sources.length}`);
  check('來源含標題、網域與可信度分層',
    sources.every((s) => s.title && s.domain && s.trustTier));
  check('**來源依可信度排序：官方在最前面**',
    sources[0]?.trustTier === 'official', JSON.stringify(sources.map((s) => s.trustTier)));
  check('有標記哪些來源真的被引用', sources.some((s) => s.isUsed));

  // 引用只能指向實際存在的來源（驗收標準 #16）
  const sourceIds = new Set(sources.map((s) => s.sourceId));
  const citations = analysis.body?.personalized?.citations ?? [];
  check('**所有引用都指向實際存在的來源**',
    citations.every((c) => sourceIds.has(c.sourceId)),
    JSON.stringify(citations.map((c) => c.sourceId)));

  console.log('\n=== SSRF 防護（規格 §17）===');
  check('**內部位址 169.254.169.254 沒有進入證據集合**',
    !sources.some((s) => s.url.includes('169.254')),
    JSON.stringify(sources.map((s) => s.url)));
  check('所有來源都是 http(s)', sources.every((s) => /^https?:\/\//.test(s.url)));

  console.log('\n=== AI 不得自行建立標籤（驗收 #12）===');
  const suggestions = await call('GET', '/tag-suggestions?status=pending&pageSize=50');
  const aiSuggestions = suggestions.body.items.filter((s) => s.source === 'ai');
  check('AI 提出的標籤進入待審佇列', aiSuggestions.length > 0,
    `n=${aiSuggestions.length}`);
  check('AI 建議的狀態為 pending', aiSuggestions.every((s) => s.status === 'pending'));

  const aiTagName = aiSuggestions[0]?.suggestedName;
  const resolved = await call('GET',
    `/tag-resolve?tagKind=knowledge&name=${encodeURIComponent(aiTagName ?? 'x')}`);
  check('**AI 建議的名稱審核前解析不到任何正式標籤**',
    resolved.body?.matchedTagId === null, JSON.stringify(resolved.body));

  const allTags = await call('GET', '/knowledge-tags?pageSize=100');
  check('正式標籤清單中沒有 AI 自創的標籤',
    !allTags.body.items.some((t) => t.name === aiTagName));

  console.log('\n=== 快取：內容未變不重複呼叫模型（規格 §12）===');
  const beforeCache = (await call('GET', '/ai/usage')).body.totalCalls;
  const again = await call('POST', `/ai/questions/${q1.id}/analyze`, { force: false }, H());
  check('重複請求回到同一個任務（冪等）', again.body?.id === start.body.id,
    `${again.body?.id} vs ${start.body.id}`);
  await sleep(1000);
  const afterCache = (await call('GET', '/ai/usage')).body.totalCalls;
  check('**重複分析完全沒有呼叫模型**', afterCache === beforeCache,
    `${beforeCache} → ${afterCache}`);

  console.log('\n=== 題目內容變更會使快取失效 ===');
  const edited = await call('PATCH', `/questions/${q1.id}`, {
    questionNumber: 1,
    type: 'single_choice',
    stem: '第 1 題（已修改）：下列何者屬於行政處分？',
    options: [
      { key: 'A', text: '拆除命令', isCorrect: true },
      { key: 'B', text: '行政指導', isCorrect: false },
      { key: 'C', text: '行政計畫', isCorrect: false },
    ],
    explanation: null,
    reviewRequired: false,
  }, H());
  check('修改題目成功', edited.status === 200);
  check('contentHash 已改變', edited.body.contentHash !== q1.contentHash);

  const staleAnalysis = await call('GET', `/questions/${q1.id}/analysis`);
  check('**既有解析被標示為已過期（isStale）**', staleAnalysis.body?.isStale === true);

  const afterEdit = await call('POST', `/ai/questions/${q1.id}/analyze`, { force: false }, H());
  check('題目改過後會產生新任務（冪等鍵含內容雜湊）',
    afterEdit.body?.id !== start.body.id);
  const afterEditDone = await waitForJob(afterEdit.body.id);
  check('新任務完成', afterEditDone.status === 'completed',
    `status=${afterEditDone.status} ${String(afterEditDone.errorMessage).slice(0, 150)}`);

  console.log('\n=== 任務進度與管理（驗收 #14）===');
  const jobs = await call('GET', '/ai/jobs?pageSize=50');
  check('可列出 AI 任務', jobs.status === 200 && jobs.body.items.length >= 2);
  check('任務含進度步驟與百分比',
    jobs.body.items.every((j) => typeof j.progressStep === 'string' && typeof j.progressPct === 'number'));

  const notFound = await call('GET', '/ai/jobs/00000000-0000-4000-8000-000000000000');
  check('不存在的任務 → 404 AI_JOB_NOT_FOUND',
    notFound.status === 404 && notFound.body.error.code === 'AI_JOB_NOT_FOUND');

  const cancelDone = await call('POST', `/ai/jobs/${start.body.id}/cancel`, undefined, H());
  check('已完成的任務不可取消 → 409',
    cancelDone.status === 409 && cancelDone.body.error.code === 'AI_JOB_NOT_CANCELLABLE',
    `status=${cancelDone.status}`);

  const retryDone = await call('POST', `/ai/jobs/${start.body.id}/retry`, undefined, H());
  check('已完成的任務不可重跑 → 409', retryDone.status === 409, `status=${retryDone.status}`);

  console.log('\n=== 用量記錄（規格 §二）===');
  const usage = await call('GET', '/ai/usage');
  check('可取得用量統計', usage.status === 200);
  check('記錄了三個階段的呼叫',
    ['research_plan', 'evidence_synthesis', 'final_explanation']
      .every((op) => usage.body.byOperation.some((r) => r.operation === op)),
    JSON.stringify(usage.body.byOperation.map((r) => r.operation)));
  check('有記錄 token 用量', usage.body.totalInputTokens > 0 && usage.body.totalOutputTokens > 0);
  check('有記錄延遲', typeof usage.body.avgLatencyMs === 'number');
  check('有結果分布統計', usage.body.byStatus.some((r) => r.status === 'success'));

  console.log('\n=== 答案衝突（驗收 #17）===');
  const noConflictYet = await call('GET', '/answer-conflicts?pageSize=50');
  check('認同題庫答案時不產生爭議',
    !noConflictYet.body.items.some((c) => c.questionId === q1.id),
    JSON.stringify(noConflictYet.body.items.map((c) => c.questionId)));

  // 題幹含衝突標記時，Mock 會回報「題庫答案有誤」——走完整的爭議路徑。
  const disputed = (await call('POST', '/questions', {
    questionGroupId: group.body.id,
    questionNumber: 3,
    type: 'single_choice',
    stem: '第 3 題【衝突測試】：下列何者屬於行政處分？',
    options: [
      { key: 'A', text: '拆除命令', isCorrect: true },
      { key: 'B', text: '行政指導', isCorrect: false },
      { key: 'C', text: '行政計畫', isCorrect: false },
    ],
    explanation: null,
    reviewRequired: false,
  }, H())).body;

  const conflictJob = await call('POST', `/ai/questions/${disputed.id}/analyze`, { force: false }, H());
  const conflictDone = await waitForJob(conflictJob.body.id);
  check('爭議題分析完成', conflictDone.status === 'completed',
    `status=${conflictDone.status} ${String(conflictDone.errorMessage).slice(0, 200)}`);

  const conflicts = await call('GET', '/answer-conflicts?reviewStatus=pending&pageSize=50');
  const conflict = conflicts.body.items.find((c) => c.questionId === disputed.id);
  check('**AI 質疑答案時建立待審爭議紀錄**', conflict !== undefined,
    JSON.stringify(conflicts.body.items.map((c) => c.questionId)));
  check('爭議記錄了題庫答案與 AI 認定的答案',
    JSON.stringify(conflict?.storedAnswers) === '["A"]' && conflict?.verifiedAnswers.length === 1,
    JSON.stringify({ s: conflict?.storedAnswers, v: conflict?.verifiedAnswers }));
  check('爭議有理由與信心值',
    Boolean(conflict?.conflictReason) && typeof conflict?.confidence === 'number');
  check('爭議附上查證來源', (conflict?.sources.length ?? 0) > 0);

  const afterConflict = await call('GET', `/questions/${disputed.id}`);
  check('**題目狀態轉為 disputed**', afterConflict.body.status === 'disputed',
    afterConflict.body.status);

  // 關鍵：AI 沒有改動題庫答案，只是提出質疑。
  const optionsNow = afterConflict.body.options.filter((o) => o.isCorrect).map((o) => o.key);
  check('**AI 沒有修改題庫的正確答案**', JSON.stringify(optionsNow) === '["A"]',
    JSON.stringify(optionsNow));

  console.log('\n=== 爭議題不影響能力診斷（驗收 #18）===');
  const statsBefore = (await call('GET', '/stats/overview')).body;

  const session = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'question_group', refId: group.body.id }], questionLimit: 20 }, H());
  // 找出爭議題在這個場次的位置
  let disputedPosition = 0;
  for (let p = 1; p <= session.body.totalQuestions; p += 1) {
    const q = await call('GET', `/quiz-sessions/${session.body.id}/questions/${p}`);
    if (q.body.questionId === disputed.id) { disputedPosition = p; break; }
  }
  check('爭議題仍可作答（只是不計入診斷）', disputedPosition > 0);

  const dq = await call('GET', `/quiz-sessions/${session.body.id}/questions/${disputedPosition}`);
  await call('POST', `/quiz-sessions/${session.body.id}/answers`,
    { sessionQuestionId: dq.body.sessionQuestionId, selectedAnswers: ['B'] }, H());

  const statsAfter = (await call('GET', '/stats/overview')).body;
  check('**爭議題的作答不計入統計的已作答數**',
    statsAfter.answeredCount === statsBefore.answeredCount,
    `${statsBefore.answeredCount} → ${statsAfter.answeredCount}`);

  const mistakeAfter = await call('GET', `/mistakes/${disputed.id}`);
  check('**爭議題答錯不會進入錯題本**', mistakeAfter.status === 404,
    `status=${mistakeAfter.status}`);

  console.log('\n=== 人工裁決（規格 §10）===');
  const badResolve = await call('POST', `/answer-conflicts/${conflict.id}/resolve`,
    { decision: 'answer_updated' }, H());
  check('選擇修改答案卻沒指定新答案 → 400', badResolve.status === 400, `status=${badResolve.status}`);

  const decision = await call('POST', `/answer-conflicts/${conflict.id}/resolve`,
    { decision: 'kept_original', reviewNote: '查過條文，題庫答案沒錯' }, H());
  check('裁決為維持原答案', decision.status === 200 && decision.body.reviewStatus === 'kept_original',
    `status=${decision.status}`);
  check('保留裁決備註', decision.body.reviewNote === '查過條文，題庫答案沒錯');

  const restored = await call('GET', `/questions/${disputed.id}`);
  check('裁決後題目恢復為 active', restored.body.status === 'active', restored.body.status);

  const statsResolved = (await call('GET', '/stats/overview')).body;
  check('**爭議解除後原本的作答重新計入統計**',
    statsResolved.answeredCount === statsBefore.answeredCount + 1,
    `${statsBefore.answeredCount} → ${statsResolved.answeredCount}`);

  const reResolve = await call('POST', `/answer-conflicts/${conflict.id}/resolve`,
    { decision: 'kept_original' }, H());
  check('重複裁決 → 409 ANSWER_CONFLICT_ALREADY_RESOLVED',
    reResolve.status === 409 && reResolve.body.error.code === 'ANSWER_CONFLICT_ALREADY_RESOLVED');

  const conflictNotFound = await call('GET', '/answer-conflicts/00000000-0000-4000-8000-000000000000');
  check('不存在的爭議 → 404 ANSWER_CONFLICT_NOT_FOUND',
    conflictNotFound.status === 404 &&
    conflictNotFound.body.error.code === 'ANSWER_CONFLICT_NOT_FOUND');

  console.log('\n=== 權限與錯誤處理 ===');
  const badQuestion = await call('POST',
    '/ai/questions/00000000-0000-4000-8000-000000000000/analyze', { force: false }, H());
  check('不存在的題目 → 404 QUESTION_NOT_FOUND',
    badQuestion.status === 404 && badQuestion.body.error.code === 'QUESTION_NOT_FOUND');

  const noAnalysis = await call('GET', `/questions/${q2.id}/analysis`);
  check('沒分析過的題目 → 404', noAnalysis.status === 404);

  const noCsrf = await call('POST', `/ai/questions/${q2.id}/analyze`, { force: false });
  check('缺少 CSRF 標頭 → 403', noCsrf.status === 403, `status=${noCsrf.status}`);

  console.log(`\n=== Phase 4 結果：${pass} 通過、${fail} 失敗 ===\n`);
  process.exit(fail === 0 ? 0 : 1);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
