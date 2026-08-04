/**
 * Phase 5 端到端驗證：統計彙總、代表錯題挑選、多題整合分析、設定與維護。
 *
 * **必須以 Mock provider 執行**（AI_PROVIDER=mock、SEARCH_PROVIDER=mock）。
 *
 * 本檔的重點不是「有沒有回 200」，而是**少掉任何一個過濾條件就會失敗**的斷言：
 * 爭議題、軟刪除題目與未交卷考試的作答，都不可以進入診斷。
 * 這些條件散落在多支查詢裡，只要有一支忘記加，下面就會有某個數字不動。
 *
 * 需先啟動後端與 Redis；預設打測試後端 :4101，可用 BASE 覆寫。
 */
const BASE = process.env.BASE ?? 'http://localhost:4101/api/v1';

// 名稱在使用者範圍內唯一，加戳記才能重複執行（見 docs/TEST_PLAN.md）。
const stamp = Date.now().toString(36);
const T = (name) => `${name}-${stamp}`;

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

/**
 * 等任務結束。
 *
 * 預設等 90 秒而不是 30 秒：整套 E2E 一輪約 32 次模型呼叫，而全域限流是 30 RPM。
 * 連續跑第二輪時必然會有呼叫被限流器擋下並等待下一個分鐘窗口——
 * 那是限流器正常運作，不是壞掉。等太短會把「正在依限流規則等待」誤判成失敗。
 */
async function waitForJob(jobId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    await sleep(300);
    last = (await call('GET', `/ai/jobs/${jobId}`)).body;
    if (['completed', 'failed', 'cancelled'].includes(last.status)) return last;
  }
  return last;
}

const aggregate = async () => (await call('GET', '/stats/aggregate')).body;
const overview = async () => (await call('GET', '/stats/overview')).body;
const mistakeStats = async () => (await call('GET', '/mistakes/stats')).body;
const sumAnswered = (rows) => rows.reduce((total, row) => total + row.answered, 0);

/** 建題 + 作答一次的捷徑。 */
async function createQuestion(groupId, number, stem, correctKey = 'A') {
  const created = await call('POST', '/questions', {
    questionGroupId: groupId,
    questionNumber: number,
    type: 'single_choice',
    stem,
    options: [
      { key: 'A', text: '甲', isCorrect: correctKey === 'A' },
      { key: 'B', text: '乙', isCorrect: correctKey === 'B' },
      { key: 'C', text: '丙', isCorrect: correctKey === 'C' },
    ],
    explanation: null,
    reviewRequired: false,
  }, H());
  return created.body;
}

/** 在指定題組建一個場次並依序作答。回傳 sessionId。 */
async function answerAll(groupId, picks, revealMode = 'immediate') {
  const session = await call('POST', '/quiz-sessions', {
    scopes: [{ scopeType: 'question_group', refId: groupId }],
    questionLimit: 50,
    revealMode,
  }, H());
  const id = session.body.id;
  for (let position = 1; position <= session.body.totalQuestions; position += 1) {
    const question = await call('GET', `/quiz-sessions/${id}/questions/${position}`);
    const pick = picks[question.body.questionId];
    if (!pick) continue;
    await call('POST', `/quiz-sessions/${id}/answers`, {
      sessionQuestionId: question.body.sessionQuestionId,
      selectedAnswers: [pick],
      responseTimeMs: 3000,
    }, H());
  }
  return id;
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

  const subject = (await call('POST', '/subjects', { name: T('診斷測試科目') }, H())).body;
  const chapter = (await call('POST', '/chapters',
    { subjectId: subject.id, name: T('第一章') }, H())).body;
  const group = (await call('POST', '/question-groups',
    { subjectId: subject.id, chapterId: chapter.id, name: T('診斷題組') }, H())).body;
  check('建立測試科目與題組', Boolean(subject.id && group.id));

  // ------------------------------------------------------------ 統計基本正確性
  console.log('\n=== 統計彙總（規格 §11、FR-AGG-01～02）===');

  const q1 = await createQuestion(group.id, 1, '第 1 題：統計測試');
  const q2 = await createQuestion(group.id, 2, '第 2 題：統計測試');
  const q3 = await createQuestion(group.id, 3, '第 3 題：統計測試');

  const base = await aggregate();
  await answerAll(group.id, { [q1.id]: 'A', [q2.id]: 'B', [q3.id]: 'B' }); // 對、錯、錯

  const afterAnswers = await aggregate();
  check('作答計入統計',
    afterAnswers.stats.overall.totalAnswered === base.stats.overall.totalAnswered + 3,
    `${base.stats.overall.totalAnswered} → ${afterAnswers.stats.overall.totalAnswered}`);
  check('答對數正確',
    afterAnswers.stats.overall.correct === base.stats.overall.correct + 1,
    `${base.stats.overall.correct} → ${afterAnswers.stats.overall.correct}`);

  const subjectBucket = afterAnswers.stats.bySubject.find((row) => row.id === subject.id);
  check('科目桶出現且數字正確',
    subjectBucket?.answered === 3 && subjectBucket?.correct === 1,
    JSON.stringify(subjectBucket));
  check('科目正確率為 33.33%', subjectBucket?.accuracy === 33.33, String(subjectBucket?.accuracy));

  const chapterBucket = afterAnswers.stats.byChapter.find((row) => row.id === chapter.id);
  check('章節桶出現', chapterBucket?.answered === 3, JSON.stringify(chapterBucket));

  check('有記錄作答時間的筆數',
    afterAnswers.stats.overall.responseTimeSamples >= 3,
    String(afterAnswers.stats.overall.responseTimeSamples));

  // ------------------------------------------------------------ 不重複計算
  console.log('\n=== 知識點扇出不得污染總數 ===');

  const tagA = (await call('POST', '/knowledge-tags',
    { name: T('主要知識點'), subjectId: subject.id }, H())).body;
  const tagB = (await call('POST', '/knowledge-tags',
    { name: T('次要知識點一'), subjectId: subject.id }, H())).body;
  const tagC = (await call('POST', '/knowledge-tags',
    { name: T('次要知識點二'), subjectId: subject.id }, H())).body;

  const q4 = await createQuestion(group.id, 4, '第 4 題：一主二次知識點');
  await call('PUT', `/questions/${q4.id}/tags`, {
    primaryKnowledgeTagId: tagA.id,
    secondaryKnowledgeTagIds: [tagB.id, tagC.id],
  }, H());

  const beforeTagged = await aggregate();
  await answerAll(group.id, { [q4.id]: 'B' }); // 只答這一題，答錯
  const afterTagged = await aggregate();

  check('**一題掛三個知識點，總作答數只加 1**',
    afterTagged.stats.overall.totalAnswered === beforeTagged.stats.overall.totalAnswered + 1,
    `${beforeTagged.stats.overall.totalAnswered} → ${afterTagged.stats.overall.totalAnswered}`);

  const taggedBuckets = afterTagged.stats.byKnowledgeTag.filter((row) =>
    [tagA.id, tagB.id, tagC.id].includes(row.id));
  check('**同一筆作答出現在 3 個知識點桶**', taggedBuckets.length === 3,
    `${taggedBuckets.length} 個桶`);

  check('**科目維度加總等於總作答數**',
    sumAnswered(afterTagged.stats.bySubject) === afterTagged.stats.overall.totalAnswered,
    `${sumAnswered(afterTagged.stats.bySubject)} vs ${afterTagged.stats.overall.totalAnswered}`);
  check('**章節維度加總等於總作答數**',
    sumAnswered(afterTagged.stats.byChapter) === afterTagged.stats.overall.totalAnswered);
  check('**題組維度加總等於總作答數**',
    sumAnswered(afterTagged.stats.byQuestionGroup) === afterTagged.stats.overall.totalAnswered);
  check('知識點維度加總大於總作答數（扇出是預期行為）',
    sumAnswered(afterTagged.stats.byKnowledgeTag) > afterTagged.stats.knowledgeTagCoverage.taggedAnswered - 1);
  check('扇出程度有被回報（coverage）',
    afterTagged.stats.knowledgeTagCoverage.taggedAnswered <
      afterTagged.stats.knowledgeTagCoverage.totalAnswered,
    JSON.stringify(afterTagged.stats.knowledgeTagCoverage));

  // 主要／次要身分要分得出來
  const primaryBucket = afterTagged.stats.byKnowledgeTag.find((row) => row.id === tagA.id);
  const secondaryBucket = afterTagged.stats.byKnowledgeTag.find((row) => row.id === tagB.id);
  check('主要知識點的 primaryAnswered 大於 0', (primaryBucket?.primaryAnswered ?? 0) > 0);
  check('純次要知識點的 primaryAnswered 為 0', secondaryBucket?.primaryAnswered === 0,
    String(secondaryBucket?.primaryAnswered));

  // ------------------------------------------------------------ 未分章節
  console.log('\n=== 未分章節依科目分桶 ===');
  const looseGroup = (await call('POST', '/question-groups',
    { subjectId: subject.id, chapterId: null, name: T('無章節題組') }, H())).body;
  const q5 = await createQuestion(looseGroup.id, 1, '第 5 題：無章節');
  await answerAll(looseGroup.id, { [q5.id]: 'A' });

  const afterLoose = await aggregate();
  const noneBucket = afterLoose.stats.byChapter.find((row) => row.id === `none:${subject.id}`);
  check('**未分章節的桶以科目為單位**', noneBucket !== undefined,
    JSON.stringify(afterLoose.stats.byChapter.map((row) => row.id)));
  check('未分章節桶仍維持章節加總不變量',
    sumAnswered(afterLoose.stats.byChapter) === afterLoose.stats.overall.totalAnswered);

  // ------------------------------------------------------------ 連續答錯
  console.log('\n=== 連續答錯統計 ===');
  const streakGroup = (await call('POST', '/question-groups',
    { subjectId: subject.id, name: T('連錯題組') }, H())).body;
  const streakTag = (await call('POST', '/knowledge-tags',
    { name: T('連錯知識點'), subjectId: subject.id }, H())).body;

  const s1 = await createQuestion(streakGroup.id, 1, '連錯 1');
  const s2 = await createQuestion(streakGroup.id, 2, '連錯 2');
  const s3 = await createQuestion(streakGroup.id, 3, '連錯 3');
  for (const q of [s1, s2, s3]) {
    await call('PUT', `/questions/${q.id}/tags`,
      { primaryKnowledgeTagId: streakTag.id, secondaryKnowledgeTagIds: [] }, H());
  }
  await answerAll(streakGroup.id, { [s1.id]: 'B', [s2.id]: 'B', [s3.id]: 'B' }); // 全錯

  const afterStreak = await aggregate();
  const streak = afterStreak.stats.consecutiveWrongStreaks.find(
    (row) => row.knowledgeTagId === streakTag.id);
  check('**連續答錯 3 題被統計出來**', streak?.streak === 3, JSON.stringify(streak));

  // 答對一題就結算
  await answerAll(streakGroup.id, { [s1.id]: 'A' });
  const afterRecover = await aggregate();
  const gone = afterRecover.stats.consecutiveWrongStreaks.find(
    (row) => row.knowledgeTagId === streakTag.id);
  check('**答對之後連續錯誤歸零，不再列出**', gone === undefined, JSON.stringify(gone));

  // ------------------------------------------------------------ 代表錯題與決定性
  console.log('\n=== 代表錯題挑選（FR-AGG-03）===');
  const withReps = await aggregate();
  check('挑出代表錯題', withReps.representativeQuestions.length > 0,
    String(withReps.representativeQuestions.length));
  check('代表錯題不超過 15 題', withReps.representativeQuestions.length <= 15);
  check('代表錯題都真的答錯過',
    withReps.representativeQuestions.every((q) => q.wrongCount > 0));
  check('代表錯題附上計分理由', withReps.representativeQuestions.every((q) => q.reasons.length > 0));

  const from = new Date(Date.now() - 30 * 86400000).toISOString();
  const to = new Date().toISOString();
  const fixed = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const first = (await call('GET', `/stats/aggregate${fixed}`)).body;
  const second = (await call('GET', `/stats/aggregate${fixed}`)).body;
  const strip = (payload) => {
    const clone = structuredClone(payload);
    clone.stats.period.generatedAt = '';
    return JSON.stringify(clone);
  };
  check('**同樣的期間呼叫兩次，結果逐位元組相同**', strip(first) === strip(second));
  check('**代表錯題的順序也相同**',
    JSON.stringify(first.representativeQuestions.map((q) => q.questionId)) ===
      JSON.stringify(second.representativeQuestions.map((q) => q.questionId)));

  // ------------------------------------------------------------ 範圍限定
  console.log('\n=== 分析範圍限定確實生效（FR-AGG-01）===');
  const unscoped = await aggregate();

  const scopedSubject = (await call('GET',
    `/stats/aggregate?scopeType=subject&scopeRefIds=${subject.id}`)).body;
  check('限定本科目時，只剩本科目的桶',
    scopedSubject.stats.bySubject.length === 1 && scopedSubject.stats.bySubject[0].id === subject.id,
    JSON.stringify(scopedSubject.stats.bySubject.map((r) => r.name)));
  check('限定科目後總數等於該科目的作答數',
    scopedSubject.stats.overall.totalAnswered === scopedSubject.stats.bySubject[0].answered,
    `${scopedSubject.stats.overall.totalAnswered} vs ${scopedSubject.stats.bySubject[0].answered}`);

  // 用一個不存在的科目 ID 限定，應該什麼都撈不到——證明條件真的有進到查詢，
  // 而不是被無聲忽略。少了這條，「範圍參數其實沒生效」看起來會跟正常一樣。
  const scopedNone = (await call('GET',
    '/stats/aggregate?scopeType=subject&scopeRefIds=00000000-0000-4000-8000-000000000000')).body;
  check('**限定到不存在的科目時統計為空（證明條件真的生效）**',
    scopedNone.stats.overall.totalAnswered === 0,
    `totalAnswered=${scopedNone.stats.overall.totalAnswered}`);
  check('限定到不存在的科目時也沒有代表錯題',
    scopedNone.representativeQuestions.length === 0);

  const scopedGroup = (await call('GET',
    `/stats/aggregate?scopeType=question_group&scopeRefIds=${group.id}`)).body;
  check('限定題組時總數少於不限定',
    scopedGroup.stats.overall.totalAnswered < unscoped.stats.overall.totalAnswered,
    `${scopedGroup.stats.overall.totalAnswered} < ${unscoped.stats.overall.totalAnswered}`);
  check('限定題組時只剩該題組的桶',
    scopedGroup.stats.byQuestionGroup.length === 1 &&
      scopedGroup.stats.byQuestionGroup[0].id === group.id,
    JSON.stringify(scopedGroup.stats.byQuestionGroup.map((r) => r.name)));

  const scopedTag = (await call('GET',
    `/stats/aggregate?scopeType=knowledge_tag&scopeRefIds=${tagA.id}`)).body;
  check('限定知識點時只剩掛該知識點的作答',
    scopedTag.stats.overall.totalAnswered > 0 &&
      scopedTag.stats.overall.totalAnswered < unscoped.stats.overall.totalAnswered,
    `${scopedTag.stats.overall.totalAnswered} < ${unscoped.stats.overall.totalAnswered}`);
  // 知識點是多對多，用 EXISTS 而非 join，因此不會把同一筆作答放大成多列。
  check('**限定知識點時總數沒有被多對多放大**',
    scopedTag.stats.overall.totalAnswered ===
      sumAnswered(scopedTag.stats.bySubject),
    `${scopedTag.stats.overall.totalAnswered} vs ${sumAnswered(scopedTag.stats.bySubject)}`);

  check('scopeType=all 等同不限定',
    (await call('GET', '/stats/aggregate?scopeType=all')).body.stats.overall.totalAnswered ===
      unscoped.stats.overall.totalAnswered);

  // ------------------------------------------------------------ 批次貼標籤
  console.log('\n=== 批次貼標籤（FR-Q-06）===');
  const bulkGroup = (await call('POST', '/question-groups',
    { subjectId: subject.id, name: T('批次標籤題組') }, H())).body;
  const b1 = await createQuestion(bulkGroup.id, 1, '批次標籤 1');
  const b2 = await createQuestion(bulkGroup.id, 2, '批次標籤 2');

  // 先給 b1 一個能力類型，等下要確認批次貼知識點不會把它清掉。
  const skillTags = (await call('GET', '/skill-tags')).body;
  const someSkill = skillTags[0];
  await call('PUT', `/questions/${b1.id}/tags`,
    { primarySkillTagId: someSkill.id, secondarySkillTagIds: [] }, H());

  const bulkTag = await call('POST', '/questions/bulk', {
    questionIds: [b1.id, b2.id],
    action: 'setKnowledgeTags',
    primaryKnowledgeTagId: tagA.id,
    secondaryKnowledgeTagIds: [tagB.id],
  }, H());
  check('批次貼標籤成功', bulkTag.status === 201 || bulkTag.status === 200,
    `status=${bulkTag.status} ${JSON.stringify(bulkTag.body)}`);
  check('回報影響 2 題', bulkTag.body?.affected === 2, JSON.stringify(bulkTag.body));

  const b1Tags = (await call('GET', `/questions/${b1.id}/tags`)).body;
  const b2Tags = (await call('GET', `/questions/${b2.id}/tags`)).body;
  check('兩題都掛上了主要知識點',
    b1Tags.knowledgeTags.some((t) => t.id === tagA.id && t.role === 'primary') &&
    b2Tags.knowledgeTags.some((t) => t.id === tagA.id && t.role === 'primary'));
  check('兩題都掛上了次要知識點',
    b1Tags.knowledgeTags.some((t) => t.id === tagB.id && t.role === 'secondary') &&
    b2Tags.knowledgeTags.some((t) => t.id === tagB.id && t.role === 'secondary'));
  check('**批次貼知識點不會清掉既有的能力類型**',
    b1Tags.skillTags.some((t) => t.id === someSkill.id),
    JSON.stringify(b1Tags.skillTags));

  check('主要與次要指同一個標籤 → 400',
    (await call('POST', '/questions/bulk', {
      questionIds: [b1.id],
      action: 'setKnowledgeTags',
      primaryKnowledgeTagId: tagA.id,
      secondaryKnowledgeTagIds: [tagA.id],
    }, H())).status === 400);

  check('批次帶入不存在的知識點 → 404',
    (await call('POST', '/questions/bulk', {
      questionIds: [b1.id],
      action: 'setKnowledgeTags',
      primaryKnowledgeTagId: '00000000-0000-4000-8000-000000000000',
      secondaryKnowledgeTagIds: [],
    }, H())).status === 404);

  // ------------------------------------------------------------ 跨端點一致
  console.log('\n=== 儀表板與錯題頁必須一致 ===');
  check('**/stats/overview 的錯題總數 === /mistakes/stats 的總數**',
    (await overview()).mistakeTotal === (await mistakeStats()).total,
    `${(await overview()).mistakeTotal} vs ${(await mistakeStats()).total}`);

  // ------------------------------------------------------------ 軟刪除
  console.log('\n=== 軟刪除的題目退出診斷 ===');
  const delGroup = (await call('POST', '/question-groups',
    { subjectId: subject.id, name: T('待刪題組') }, H())).body;
  const delQ = await createQuestion(delGroup.id, 1, '這題等下會被刪掉');
  await answerAll(delGroup.id, { [delQ.id]: 'B' }); // 答錯 → 進錯題本

  const beforeDelete = await aggregate();
  const overviewBefore = await overview();
  check('刪除前這題在錯題本裡',
    (await call('GET', `/mistakes/${delQ.id}`)).status === 200);

  await call('DELETE', `/questions/${delQ.id}`, undefined, H());

  const afterDelete = await aggregate();
  check('**軟刪除後該筆作答退出統計**',
    afterDelete.stats.overall.totalAnswered === beforeDelete.stats.overall.totalAnswered - 1,
    `${beforeDelete.stats.overall.totalAnswered} → ${afterDelete.stats.overall.totalAnswered}`);
  check('**軟刪除後儀表板的錯題總數也下降**',
    (await overview()).mistakeTotal === overviewBefore.mistakeTotal - 1,
    `${overviewBefore.mistakeTotal} → ${(await overview()).mistakeTotal}`);
  check('刪除後兩個端點的錯題總數仍然一致',
    (await overview()).mistakeTotal === (await mistakeStats()).total);

  // ------------------------------------------------------------ 交卷後對答案不得洩漏
  console.log('\n=== 未交卷的「交卷後對答案」場次不得洩漏（驗收 #7）===');
  const examGroup = (await call('POST', '/question-groups',
    { subjectId: subject.id, name: T('模擬考題組') }, H())).body;
  const examQ = await createQuestion(examGroup.id, 1, '模擬考題目');

  const mistakeBeforeExam = (await mistakeStats()).total;
  const examSession = await answerAll(examGroup.id, { [examQ.id]: 'B' }, 'after_submit');

  check('**未交卷前這題不出現在錯題本**',
    (await call('GET', `/mistakes/${examQ.id}`)).status === 404);
  check('**未交卷前錯題總數不變（數字本身也會洩漏）**',
    (await mistakeStats()).total === mistakeBeforeExam,
    `${mistakeBeforeExam} → ${(await mistakeStats()).total}`);
  check('未交卷前兩個端點仍然一致',
    (await overview()).mistakeTotal === (await mistakeStats()).total);

  await call('POST', `/quiz-sessions/${examSession}/submit`, {}, H());

  check('**交卷後這題正常出現在錯題本**',
    (await call('GET', `/mistakes/${examQ.id}`)).status === 200);
  check('交卷後錯題總數增加',
    (await mistakeStats()).total === mistakeBeforeExam + 1,
    `${mistakeBeforeExam} → ${(await mistakeStats()).total}`);

  // ------------------------------------------------------------ 爭議題
  console.log('\n=== 爭議題退出診斷（驗收 #18）===');
  const conflictGroup = (await call('POST', '/question-groups',
    { subjectId: subject.id, name: T('爭議題組') }, H())).body;
  const conflictTag = (await call('POST', '/knowledge-tags',
    { name: T('爭議知識點'), subjectId: subject.id }, H())).body;
  const conflictQ = await createQuestion(conflictGroup.id, 1, '第 6 題【衝突測試】：爭議題');
  await call('PUT', `/questions/${conflictQ.id}/tags`,
    { primaryKnowledgeTagId: conflictTag.id, secondaryKnowledgeTagIds: [] }, H());
  await answerAll(conflictGroup.id, { [conflictQ.id]: 'B' }); // 答錯

  const beforeConflict = await aggregate();
  const conflictSubjectBefore = beforeConflict.stats.bySubject.find((r) => r.id === subject.id);
  const conflictTagBefore = beforeConflict.stats.byKnowledgeTag.find((r) => r.id === conflictTag.id);
  check('爭議前這題已計入知識點統計', (conflictTagBefore?.answered ?? 0) === 1);

  const job = await call('POST', `/ai/questions/${conflictQ.id}/analyze`, { force: false }, H());
  const done = await waitForJob(job.body.id);
  check('爭議題分析完成', done.status === 'completed', `${done.status} ${done.errorMessage ?? ''}`);

  const afterConflict = await aggregate();
  check('**爭議建立後總作答數減 1**',
    afterConflict.stats.overall.totalAnswered === beforeConflict.stats.overall.totalAnswered - 1,
    `${beforeConflict.stats.overall.totalAnswered} → ${afterConflict.stats.overall.totalAnswered}`);

  const conflictSubjectAfter = afterConflict.stats.bySubject.find((r) => r.id === subject.id);
  check('**科目桶也同步減 1**',
    conflictSubjectAfter.answered === conflictSubjectBefore.answered - 1,
    `${conflictSubjectBefore.answered} → ${conflictSubjectAfter.answered}`);

  const conflictTagAfter = afterConflict.stats.byKnowledgeTag.find((r) => r.id === conflictTag.id);
  check('**知識點桶也同步移除**', conflictTagAfter === undefined,
    JSON.stringify(conflictTagAfter));

  // ------------------------------------------------------------ 裁決後還原
  console.log('\n=== 裁決後回到原本的數字 ===');
  const conflict = (await call('GET', '/answer-conflicts?reviewStatus=pending&pageSize=50'))
    .body.items.find((c) => c.questionId === conflictQ.id);
  check('取得待審爭議', conflict !== undefined);

  await call('POST', `/answer-conflicts/${conflict.id}/resolve`,
    { decision: 'kept_original', reviewNote: '查證後題庫答案無誤' }, H());

  const afterResolve = await aggregate();
  check('**裁決後總作答數回到原值（證明排除是過濾而非刪除）**',
    afterResolve.stats.overall.totalAnswered === beforeConflict.stats.overall.totalAnswered,
    `${beforeConflict.stats.overall.totalAnswered} → ${afterResolve.stats.overall.totalAnswered}`);
  const tagRestored = afterResolve.stats.byKnowledgeTag.find((r) => r.id === conflictTag.id);
  check('**知識點桶也回來了**', tagRestored?.answered === conflictTagBefore.answered,
    JSON.stringify(tagRestored));

  // ------------------------------------------------------------ 多題整合分析
  console.log('\n=== 多題整合分析（驗收 #19）===');
  /*
   * 只數 aggregate_analysis 這個 operation **真正送出**的呼叫次數。
   *
   * 兩個地方都要精確，缺一不可：
   *
   *   1. 用全域 totalCalls 會被同時在跑的其他任務污染。
   *   2. 用 calls 會把「被本地限流器擋下」的嘗試也算進去——那沒有打到模型。
   *      整套 E2E 一輪約 32 次呼叫、限流是 30 RPM，連續重跑必然會撞到，
   *      於是這條斷言偶發地量到 2。不是程式壞掉，是量錯了東西。
   */
  const aggregateCalls = async () => {
    const usage = (await call('GET', '/ai/usage')).body;
    return usage.byOperation.find((o) => o.operation === 'aggregate_analysis')?.successCalls ?? 0;
  };
  const usageBefore = await aggregateCalls();

  const started = await call('POST', '/ai/aggregate-analyses',
    { scopeType: 'all', force: true }, H());
  check('啟動分析回 202 與 jobId', started.status === 202 && Boolean(started.body.id),
    `status=${started.status}`);
  check('任務類型為 aggregate_analysis', started.body.jobType === 'aggregate_analysis');

  const aggJob = await waitForJob(started.body.id);
  check('分析完成', aggJob.status === 'completed',
    `${aggJob.status} ${aggJob.errorCode ?? ''} ${aggJob.errorMessage ?? ''}`);
  check('進度走到 100%', aggJob.progressPct === 100);

  const usageAfter = await aggregateCalls();
  check('**多題分析只呼叫一次模型**（單題是三次）', usageAfter - usageBefore === 1,
    `增量 ${usageAfter - usageBefore}`);

  const latest = (await call('GET', '/ai/aggregate-analyses/latest')).body;
  check('可取得最近一次分析', latest !== null && Boolean(latest.id));
  check('保存了模型與 prompt 版本',
    Boolean(latest.model) && Boolean(latest.promptVersion),
    `${latest.model} / ${latest.promptVersion}`);
  check('**保存了統計快照（FR-AGG-05：結論可回頭驗證）**',
    latest.statsSnapshot != null && latest.statsSnapshot.stats?.overall != null);
  check('保存了代表錯題 ID', latest.representativeQuestionIds.length > 0);
  check('代表錯題不超過 15 題', latest.representativeQuestionIds.length <= 15);
  check('有學習建議', latest.learningSuggestions.length > 0);
  check('有分析依據', latest.analysisBasis.length > 0);

  // 參照完整性：AI 只能引用輸入裡出現過的東西
  const snapshot = latest.statsSnapshot;
  const allowedRefs = new Set([
    ...(snapshot.representativeQuestions ?? []).map((q) => q.questionId),
    ...(snapshot.stats?.byQuestionGroup ?? []).map((g) => g.id),
    ...(snapshot.stats?.byKnowledgeTag ?? []).map((t) => t.id),
  ]);
  check('**推薦的複習目標都指向真實存在的對象**',
    latest.recommendedPractice.every((item) => allowedRefs.has(item.refId)),
    JSON.stringify(latest.recommendedPractice.filter((i) => !allowedRefs.has(i.refId))));

  const allowedTagNames = new Set((snapshot.stats?.byKnowledgeTag ?? []).map((t) => t.name));
  check('**最薄弱知識點的名稱都來自輸入統計，沒有自創**',
    latest.weakestKnowledgeTags.every((tag) => allowedTagNames.has(tag.tagName)),
    JSON.stringify(latest.weakestKnowledgeTags.map((t) => t.tagName)));

  const ranks = latest.reviewPriority.map((item) => item.rank).sort((a, b) => a - b);
  check('**複習優先序從 1 開始連續不重複**',
    ranks.every((rank, index) => rank === index + 1), JSON.stringify(ranks));

  const listed = (await call('GET', '/ai/aggregate-analyses')).body;
  check('可列出歷次分析', Array.isArray(listed) && listed.length > 0);
  check('可依 ID 取得單筆',
    (await call('GET', `/ai/aggregate-analyses/${latest.id}`)).body.id === latest.id);
  check('不存在的分析 → 404',
    (await call('GET', '/ai/aggregate-analyses/00000000-0000-4000-8000-000000000000')).status === 404);

  // ------------------------------------------------------------ 錯誤類型次數
  console.log('\n=== 錯誤類型次數（occurrence_count）===');
  const errorTypes = (await call('GET', '/error-types')).body;
  const anyErrorType = errorTypes[0];
  const mistakeQ = withReps.representativeQuestions[0];
  if (mistakeQ && anyErrorType) {
    const readCount = async () => {
      const detail = (await call('GET', `/mistakes/${mistakeQ.questionId}`)).body;
      return detail.errorTypes?.find((t) => t.errorTypeId === anyErrorType.id)?.occurrenceCount ?? 0;
    };
    await call('PUT', `/mistakes/${mistakeQ.questionId}/error-types`,
      { errorTypeIds: [anyErrorType.id] }, H());
    const afterFirst = await readCount();
    await call('PUT', `/mistakes/${mistakeQ.questionId}/error-types`,
      { errorTypeIds: [anyErrorType.id] }, H());
    const afterSecond = await readCount();
    check('**重複儲存同一份手動錯因不會累加次數**', afterFirst === afterSecond,
      `${afterFirst} → ${afterSecond}`);
  }

  // ------------------------------------------------------------ 設定
  console.log('\n=== 系統設定 ===');
  const settings = await call('GET', '/settings');
  check('可取得設定', settings.status === 200);
  check('含作答預設值', settings.body.quizDefaults?.mode !== undefined);
  check('含系統資訊', Boolean(settings.body.system?.model));
  check('**機密只回傳布林值，不含內容**',
    Object.values(settings.body.system.secretsConfigured).every((v) => typeof v === 'boolean'),
    JSON.stringify(settings.body.system.secretsConfigured));
  const serialized = JSON.stringify(settings.body);
  check('**設定回應不含任何金鑰內容**',
    !serialized.includes('nvapi-') && !serialized.includes('tvly-') &&
    !serialized.includes('postgresql://'),
    '回應中出現疑似金鑰');

  const updated = await call('PATCH', '/settings',
    { quizDefaults: { questionLimit: 25, revealMode: 'after_submit' } }, H());
  check('可更新作答預設值',
    updated.body.quizDefaults.questionLimit === 25 &&
    updated.body.quizDefaults.revealMode === 'after_submit',
    JSON.stringify(updated.body.quizDefaults));
  check('未指定的欄位保持原值', updated.body.quizDefaults.mode !== undefined);

  const persisted = await call('GET', '/settings');
  check('設定有持久化', persisted.body.quizDefaults.questionLimit === 25);

  const badUpdate = await call('PATCH', '/settings',
    { quizDefaults: { questionLimit: 99999 } }, H());
  check('超出上限的題數 → 400', badUpdate.status === 400, `status=${badUpdate.status}`);

  // ------------------------------------------------------------ Prompt 版本
  console.log('\n=== Prompt 版本（唯讀）===');
  const versions = await call('GET', '/ai/prompt-versions');
  check('可列出 prompt 版本', versions.status === 200 && versions.body.length >= 4);
  check('四個階段都有版本',
    ['research_plan', 'evidence_synthesis', 'final_explanation', 'aggregate_analysis']
      .every((op) => versions.body.some((v) => v.operation === op)),
    JSON.stringify(versions.body.map((v) => v.operation)));
  check('**不回傳 prompt 內文**',
    versions.body.every((v) => v.systemPrompt === undefined && v.userTemplate === undefined));

  /*
   * 每個階段恰好一個啟用版本。
   *
   * 這條抓的是一次真實的啟動失敗：seed 原本「先插入新版本（isActive: true）
   * 再停用舊版本」，但 prompt_versions_active_unique 是
   * (operation) WHERE is_active = true 的部分唯一索引——插入當下舊版本還啟用著，
   * 索引立刻擋下，後面那句 UPDATE 根本執行不到，整個應用起不來。
   *
   * 這個缺陷藏了很久，因為所有測試資料庫都是全新建立的，沒有舊版本可衝突。
   * 「全新安裝可以跑」不等於「升級可以跑」——升級路徑要自己測。
   */
  const activeByOperation = new Map();
  for (const v of versions.body.filter((x) => x.isActive)) {
    activeByOperation.set(v.operation, (activeByOperation.get(v.operation) ?? 0) + 1);
  }
  check('**每個階段恰好一個啟用版本**',
    ['research_plan', 'evidence_synthesis', 'final_explanation', 'aggregate_analysis']
      .every((op) => activeByOperation.get(op) === 1),
    JSON.stringify([...activeByOperation.entries()]));

  // ------------------------------------------------------------ 維護
  console.log('\n=== 維護作業 ===');
  const preview = await call('GET', '/maintenance/preview');
  check('可預覽待清理項目', preview.status === 200 &&
    typeof preview.body.expiredWebDocuments === 'number');

  const cleanup = await call('POST', '/maintenance/cleanup', { recomputeMistakes: true }, H());
  check('可執行清理', cleanup.status === 200);
  check('回報清掉幾筆', typeof cleanup.body.deletedWebDocuments === 'number');
  check('回報重算幾筆錯題', cleanup.body.recomputedMistakeRecords > 0,
    String(cleanup.body.recomputedMistakeRecords));

  const afterCleanup = await aggregate();
  check('**維護作業不會改變統計數字（只清快取，不動作答歷史）**',
    afterCleanup.stats.overall.totalAnswered === afterResolve.stats.overall.totalAnswered,
    `${afterResolve.stats.overall.totalAnswered} → ${afterCleanup.stats.overall.totalAnswered}`);
  check('重算後兩個端點仍然一致',
    (await overview()).mistakeTotal === (await mistakeStats()).total);

  // ------------------------------------------------------------ 權限與錯誤
  console.log('\n=== 權限與錯誤處理 ===');
  check('缺少 CSRF 標頭 → 403',
    (await call('POST', '/ai/aggregate-analyses', { scopeType: 'all' })).status === 403);
  check('scopeType 非 all 卻沒給 scopeRefIds → 400',
    (await call('POST', '/ai/aggregate-analyses',
      { scopeType: 'subject', scopeRefIds: [] }, H())).status === 400);
  check('from 晚於 to → 400',
    (await call('POST', '/ai/aggregate-analyses',
      { scopeType: 'all', from: to, to: from }, H())).status === 400);

  const saved = new Map(jar);
  jar.clear();
  check('未登入存取統計 → 401', (await call('GET', '/stats/aggregate')).status === 401);
  check('未登入存取設定 → 401', (await call('GET', '/settings')).status === 401);
  for (const [k, v] of saved) jar.set(k, v);

  console.log(`\n=== Phase 5 結果：${pass} 通過、${fail} 失敗 ===`);
  process.exit(fail === 0 ? 0 : 1);
};

run().catch((e) => { console.error('測試執行失敗：', e); process.exit(1); });
