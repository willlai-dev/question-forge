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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let csrf = '';
const H = () => ({ 'X-CSRF-Token': csrf });
async function refreshCsrf() {
  csrf = (await call('GET', '/auth/csrf')).body.csrfToken;
}

/** 等任務結束。逾時就回傳最後看到的狀態，讓失敗訊息帶得出診斷資訊。 */
/** 單題分析的合法進度步驟。與 packages/contracts/src/api/ai.ts 的 enum 一致。 */
const KNOWN_QUESTION_STEPS = new Set([
  'QUEUED',
  'ANALYZING_QUESTION',
  'SEARCHING_SOURCES',
  'SYNTHESIZING_EVIDENCE',
  'GENERATING_EXPLANATION',
  'SAVING_RESULT',
  'COMPLETED',
]);

/**
 * 等任務結束，並把過程中觀察到的每個進度步驟記錄在 `observedSteps`。
 *
 * 預設等 90 秒而非 30 秒：整套 E2E 一輪的模型呼叫數已超過全域限流的 30 RPM，
 * 連續跑第二輪時必然會有呼叫被限流器擋下、等待下一個分鐘窗口。
 * 那是限流器正常運作，等太短會把「正在依規則等待」誤判成失敗。
 *
 * 刻意**不**斷言「一定要看到某個中間步驟」：Mock 很快，輪詢是否剛好撞上
 * 某一階段完全取決於時序，那種斷言會變成隨機失敗的測試。
 * 這裡驗的是可以穩定成立的性質——觀察到的每個步驟都必須是合法值。
 * 這條抓得到的真實迴歸是：service 回報了 enum 以外的步驟，
 * 而 AiJobsService.toResponse 會把未知步驟默默降級成 QUEUED，
 * 進度條就會卡在 0% 而沒有任何人發現。
 */
async function waitForJob(jobId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  const observedSteps = [];
  while (Date.now() < deadline) {
    await sleep(300);
    last = (await call('GET', `/ai/jobs/${jobId}`)).body;
    if (last?.progressStep && !observedSteps.includes(last.progressStep)) {
      observedSteps.push(last.progressStep);
    }
    if (['completed', 'failed', 'cancelled'].includes(last.status)) {
      last.observedSteps = observedSteps;
      return last;
    }
  }
  if (last) last.observedSteps = observedSteps;
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

  // 這次分析沒有帶作答，因此不會有個人化區塊。
  //
  // 原本這裡對 `personalized.citations` 做 every() 檢查並宣稱驗證了驗收 #16——
  // 但沒帶作答時 personalized 為 null、citations 恆為空陣列，
  // 而空陣列的 every() 永遠是 true，所以那是一條**永遠通過的空斷言**。
  // 真正的 #16 驗證移到下方「帶作答」的路徑，那裡引用才真的存在。
  check('沒有帶作答時不產生個人化區塊', analysis.body?.personalized === null,
    JSON.stringify(analysis.body?.personalized));
  check('題目層解析仍附上來源清單', sources.length > 0, `sources=${sources.length}`);

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

  // 上面那組只證明了「同一個任務不會重跑」（冪等鍵相同 → 回到同一個 job），
  // 並沒有碰到 content_hash 快取本身。這裡刻意用不同的冪等鍵建立**新的**任務：
  // 帶上 userAnswerId 會讓 discriminator 改變，因此一定是新 job，
  // 但題目內容沒變，所以應該命中快取、servedFromCache 為 true 且不呼叫模型。
  // 用另一題（q2）測真正的 content_hash 快取路徑。
  //
  // 順序很重要：先「帶作答」分析一次把題目層解析與個人化解析都建立起來，
  // 再「不帶作答」分析一次。後者的冪等鍵不同（discriminator 含 userAnswerId），
  // 因此一定是新任務；而題目內容沒變、又不需要個人化解析，
  // 所以必須命中快取。這才是快取本身，不是「同一個任務不重跑」的冪等。
  const cacheSession = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'question_group', refId: group.body.id }], questionLimit: 50 }, H());
  let answerForCache = null;
  for (let p = 1; p <= cacheSession.body.totalQuestions; p += 1) {
    const q = await call('GET', `/quiz-sessions/${cacheSession.body.id}/questions/${p}`);
    if (q.body.questionId !== q2.id) continue;
    const submitted = await call('POST', `/quiz-sessions/${cacheSession.body.id}/answers`,
      { sessionQuestionId: q.body.sessionQuestionId, selectedAnswers: ['B'] }, H());
    answerForCache = submitted.body?.answerId ?? null;
    break;
  }
  check('取得 q2 的作答', answerForCache !== null);

  if (answerForCache) {
    const withAnswer = await call('POST', `/ai/questions/${q2.id}/analyze`,
      { force: false, userAnswerId: answerForCache }, H());
    const withAnswerDone = await waitForJob(withAnswer.body.id);
    check('q2 帶作答的分析完成', withAnswerDone.status === 'completed',
      String(withAnswerDone.status));
    check('第一次分析不是來自快取', withAnswerDone.servedFromCache === false,
      `servedFromCache=${withAnswerDone.servedFromCache}`);
    // 帶作答的分析必定有個人化區塊，引用才有出口——這也是上面 #16 斷言真正該跑的路徑。
    const withAnswerAnalysis = await call('GET',
      `/questions/${q2.id}/analysis?userAnswerId=${answerForCache}`);
    const personalCitations = withAnswerAnalysis.body?.personalized?.citations ?? [];
    const q2SourceIds = new Set((withAnswerAnalysis.body?.sources ?? []).map((s) => s.sourceId));
    check('帶作答的分析確實產生了引用', personalCitations.length > 0,
      `citations=${personalCitations.length}`);
    check('**帶作答分析的引用都指向實際存在的來源（驗收 #16）**',
      personalCitations.length > 0 && personalCitations.every((c) => q2SourceIds.has(c.sourceId)),
      JSON.stringify(personalCitations.map((c) => c.sourceId)));

    const beforeHash = (await call('GET', '/ai/usage')).body.totalCalls;
    const cacheJob = await call('POST', `/ai/questions/${q2.id}/analyze`, { force: false }, H());
    check('不帶作答時的冪等鍵不同，建立的是新任務',
      cacheJob.body?.id !== withAnswer.body.id,
      `${cacheJob.body?.id} vs ${withAnswer.body.id}`);
    const cacheDone = await waitForJob(cacheJob.body.id);
    check('新任務完成', cacheDone.status === 'completed', String(cacheDone.status));
    check('**新任務由 content_hash 快取服務（servedFromCache）**',
      cacheDone.servedFromCache === true, `servedFromCache=${cacheDone.servedFromCache}`);
    const afterHash = (await call('GET', '/ai/usage')).body.totalCalls;
    check('**命中快取的新任務沒有呼叫模型**', afterHash === beforeHash,
      `${beforeHash} → ${afterHash}`);
  }

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

  // 使用者的實際用法：按下分析之後先去做下一題，等一下再回來看。
  // 因此「哪個任務在跑」不能只存在前端的元件狀態裡——離開再回來就沒了。
  console.log('\n=== 分析結果會存著，且離開後回得來 ===');

  const foundByQuestion = await call('GET', `/ai/jobs?questionId=${q1.id}&pageSize=1`);
  check('**可用 questionId 找回這一題的分析任務**',
    foundByQuestion.body?.items?.[0]?.questionId === q1.id,
    JSON.stringify(foundByQuestion.body?.items?.map((j) => j.questionId)));

  const readA = await call('GET', `/questions/${q1.id}/analysis`);
  const readB = await call('GET', `/questions/${q1.id}/analysis`);
  check('解析可重複讀取', readA.status === 200 && readB.status === 200);
  check('**重複讀取的內容完全相同**',
    JSON.stringify(readA.body) === JSON.stringify(readB.body));

  const beforeReread = (await call('GET', '/ai/usage')).body.totalCalls;
  await call('GET', `/questions/${q1.id}/analysis`);
  const afterReread = (await call('GET', '/ai/usage')).body.totalCalls;
  check('**重複讀取解析不會再呼叫模型**', afterReread === beforeReread,
    `${beforeReread} → ${afterReread}`);

  // 另一題不能沿用這一題的解析。
  const otherAnalysis = await call('GET', `/questions/${q2.id}/analysis`);
  check('不同題目的解析各自獨立',
    otherAnalysis.status !== 200 || otherAnalysis.body.questionId === q2.id,
    `questionId=${otherAnalysis.body?.questionId}`);

  console.log('\n=== 任務進度與管理（驗收 #14）===');
  const jobs = await call('GET', '/ai/jobs?pageSize=50');
  check('可列出 AI 任務', jobs.status === 200 && jobs.body.items.length >= 2);
  check('任務含進度步驟與百分比',
    jobs.body.items.every((j) => typeof j.progressStep === 'string' && typeof j.progressPct === 'number'));
  check('**列出的每個任務的進度步驟都是合法值**',
    jobs.body.items.every((j) => KNOWN_QUESTION_STEPS.has(j.progressStep)),
    JSON.stringify([...new Set(jobs.body.items.map((j) => j.progressStep))]));
  // 進度是真的有在推進，不是從頭到尾停在 QUEUED。
  check('**分析過程中觀察到的步驟都是合法值**',
    (done.observedSteps ?? []).every((step) => KNOWN_QUESTION_STEPS.has(step)),
    JSON.stringify(done.observedSteps));
  check('**完成的任務停在 COMPLETED 且為 100%**',
    done.progressStep === 'COMPLETED' && done.progressPct === 100,
    `${done.progressStep} ${done.progressPct}%`);

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

  // 上面那段是「先有爭議、才作答」的順序，那是簡單情況：作答寫入時題目已是
  // disputed，is_provisional 當場就是 true。真實使用順序剛好相反 ——
  // 先答錯 → 進錯題本 → 在錯題頁按「AI 分析」→ 才產生爭議。
  // 觸發分析的那一筆作答必然早於 disputed，若不回頭補標，最該排除的那筆反而留在診斷裡。
  console.log('\n=== 爭議「之前」就存在的作答也必須退出診斷（驗收 #18）===');
  const preGroup = await call('POST', '/question-groups',
    { subjectId: subject.body.id, name: `爭議前作答-${stamp}` }, H());
  const preQ = (await call('POST', '/questions', {
    questionGroupId: preGroup.body.id,
    questionNumber: 1,
    type: 'single_choice',
    stem: '第 4 題【衝突測試】：下列何者屬於行政處分？',
    options: [
      { key: 'A', text: '拆除命令', isCorrect: true },
      { key: 'B', text: '行政指導', isCorrect: false },
      { key: 'C', text: '行政計畫', isCorrect: false },
    ],
    explanation: null,
    reviewRequired: false,
  }, H())).body;

  // 1) 先答錯（此時題目還是 active，作答正常計入）
  const preSession = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'question_group', refId: preGroup.body.id }], questionLimit: 5 }, H());
  const preQuestion = await call('GET', `/quiz-sessions/${preSession.body.id}/questions/1`);
  await call('POST', `/quiz-sessions/${preSession.body.id}/answers`,
    { sessionQuestionId: preQuestion.body.sessionQuestionId, selectedAnswers: ['B'] }, H());

  const statsPre = (await call('GET', '/stats/overview')).body;
  const mistakePre = await call('GET', `/mistakes/${preQ.id}`);
  check('分析前：答錯已計入統計且進了錯題本', mistakePre.status === 200,
    `status=${mistakePre.status}`);

  // 2) 現在才做 AI 分析 → 產生爭議
  const preJob = await call('POST', `/ai/questions/${preQ.id}/analyze`, { force: false }, H());
  const preDone = await waitForJob(preJob.body.id);
  check('爭議題（先作答後分析）分析完成', preDone.status === 'completed',
    `status=${preDone.status}`);

  const statsPost = (await call('GET', '/stats/overview')).body;
  check('**爭議建立後，先前那筆作答一併退出統計**',
    statsPost.answeredCount === statsPre.answeredCount - 1,
    `${statsPre.answeredCount} → ${statsPost.answeredCount}`);
  check('**爭議建立後，先前那筆錯題一併退出錯題本**',
    (await call('GET', `/mistakes/${preQ.id}`)).status === 404);

  const preConflict = (await call('GET', '/answer-conflicts?reviewStatus=pending&pageSize=50'))
    .body.items.find((c) => c.questionId === preQ.id);
  check('這題確實有待審爭議', preConflict !== undefined);

  // 3) 裁決為「修改答案」，把正確答案改成使用者當初選的 B
  console.log('\n=== 改答案後必須重新判分（規格 §六：判分一律由程式執行）===');
  const updated = await call('POST', `/answer-conflicts/${preConflict.id}/resolve`,
    { decision: 'answer_updated', correctAnswers: ['B'], reviewNote: '查證後題庫答案有誤' }, H());
  check('裁決為修改答案', updated.status === 200 && updated.body.reviewStatus === 'answer_updated',
    `status=${updated.status}`);

  const fixedQuestion = await call('GET', `/questions/${preQ.id}`);
  check('題庫正確答案已改為 B',
    JSON.stringify(fixedQuestion.body.options.filter((o) => o.isCorrect).map((o) => o.key)) === '["B"]',
    JSON.stringify(fixedQuestion.body.options.filter((o) => o.isCorrect).map((o) => o.key)));
  check('題目恢復為 active', fixedQuestion.body.status === 'active', fixedQuestion.body.status);

  const statsRegraded = (await call('GET', '/stats/overview')).body;
  check('改答案後作答恢復計入統計',
    statsRegraded.answeredCount === statsPre.answeredCount,
    `${statsPre.answeredCount} → ${statsRegraded.answeredCount}`);
  // 使用者當初選 B、被判錯；答案改成 B 之後，那一筆必須重新判為答對，
  // 否則等於用「新答案」的名義把「舊答案的判定」放回統計。
  check('**改答案後原本的作答重新判分為答對**',
    statsRegraded.correctCount === statsPre.correctCount + 1,
    `correct ${statsPre.correctCount} → ${statsRegraded.correctCount}`);
  check('**重新判分後這題不再是錯題**',
    (await call('GET', `/mistakes/${preQ.id}`)).status === 404);

  console.log('\n=== 人工裁決（規格 §10）===');
  // 重新取基準：上面那段也動到了統計，不能再拿 statsBefore 當比較點。
  const statsBeforeResolve = (await call('GET', '/stats/overview')).body;
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
    statsResolved.answeredCount === statsBeforeResolve.answeredCount + 1,
    `${statsBeforeResolve.answeredCount} → ${statsResolved.answeredCount}`);

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

  // 用一題全新的：q1 與 q2 都已經在前面被分析過了。
  const neverAnalyzed = (await makeQuestion(90)).body;
  const noAnalysis = await call('GET', `/questions/${neverAnalyzed.id}/analysis`);
  check('沒分析過的題目 → 404', noAnalysis.status === 404, `status=${noAnalysis.status}`);

  const noCsrf = await call('POST', `/ai/questions/${q2.id}/analyze`, { force: false });
  check('缺少 CSRF 標頭 → 403', noCsrf.status === 403, `status=${noCsrf.status}`);

  console.log(`\n=== Phase 4 結果：${pass} 通過、${fail} 失敗 ===\n`);
  process.exit(fail === 0 ? 0 : 1);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
