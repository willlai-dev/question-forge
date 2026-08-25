/**
 * Phase 2 端到端驗證：作答、判分、揭露模式與錯題本。
 *
 * 以 Node fetch 執行，避免 shell 字碼頁轉換污染中文測試資料。
 * 需先啟動後端；預設打 :4000，可用 BASE 覆寫。
 *
 * 本檔最重要的兩組斷言：
 *   1. after_submit 模式交卷前，回應中不得有任何答案資訊 —— 用整份 JSON 深度掃描，
 *      而不是只檢查已知欄位，否則日後新增欄位就會漏測（FR-QUIZ-11）。
 *   2. 修改答案後錯題紀錄不得重複累加 —— 錯題紀錄是作答歷史的衍生狀態。
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

/**
 * 遞迴搜尋整個回應，找出任何看起來像「答案」的鍵。
 * 逐欄位列舉會隨著契約演進而失效；掃描整棵樹才擋得住日後不小心新增的洩漏管道。
 */
const ANSWER_KEYS = ['correctanswers', 'iscorrect', 'correctanswerssnapshot', 'explanation', 'reveal'];
function findAnswerLeaks(value, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => findAnswerLeaks(item, `${path}[${i}]`, found));
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const here = `${path}.${key}`;
      // reveal: null 是契約明定的「沒有答案」表示法，不算洩漏。
      if (ANSWER_KEYS.includes(key.toLowerCase()) && child !== null) found.push(here);
      findAnswerLeaks(child, here, found);
    }
  }
  return found;
}

const single = (n, correct, extra = {}) => ({
  questionNumber: n,
  type: 'single_choice',
  stem: `第 ${n} 題：下列何者屬於行政處分？`,
  options: [
    { key: 'A', text: '行政指導', isCorrect: correct === 'A' },
    { key: 'B', text: '拆除命令', isCorrect: correct === 'B' },
    { key: 'C', text: '行政計畫', isCorrect: correct === 'C' },
    { key: 'D', text: '行政契約', isCorrect: correct === 'D' },
  ],
  explanation: null,
  reviewRequired: false,
  ...extra,
});

const multiple = (n, corrects, extra = {}) => ({
  questionNumber: n,
  type: 'multiple_choice',
  stem: `第 ${n} 題：下列何者屬於行政罰？（複選）`,
  options: ['A', 'B', 'C', 'D'].map((key, i) => ({
    key,
    text: `選項 ${key}（${['罰鍰', '沒入', '申誡', '拘役'][i]}）`,
    isCorrect: corrects.includes(key),
  })),
  explanation: '行政罰法第 1 條與第 2 條。',
  reviewRequired: false,
  ...extra,
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
  const subject = await call('POST', '/subjects', { name: `作答測試科目 ${stamp}` }, H());
  const chapter = await call('POST', '/chapters', { subjectId: subject.body.id, name: '第一章 行政處分' }, H());
  const group = await call('POST', '/question-groups',
    { subjectId: subject.body.id, chapterId: chapter.body.id, name: '作答測試題組' }, H());
  const emptyGroup = await call('POST', '/question-groups',
    { subjectId: subject.body.id, name: '沒有題目的題組' }, H());
  check('建立科目／章節／題組', subject.status === 201 && chapter.status === 201 && group.status === 201,
    `subject=${subject.status} chapter=${chapter.status} group=${group.status}`);

  // 5 題單選（答案 B、A、C、D、B）+ 1 題複選（AB）
  const correctByNumber = { 1: ['B'], 2: ['A'], 3: ['C'], 4: ['D'], 5: ['B'], 6: ['A', 'B'] };
  for (const [n, answers] of Object.entries(correctByNumber)) {
    const payload = answers.length === 1
      ? single(Number(n), answers[0], { questionGroupId: group.body.id })
      : multiple(Number(n), answers, { questionGroupId: group.body.id });
    const created = await call('POST', '/questions', payload, H());
    if (created.status !== 201) check(`建立第 ${n} 題`, false, JSON.stringify(created.body));
  }
  const bank = await call('GET', `/questions?questionGroupId=${group.body.id}&pageSize=50`);
  check('題庫共 6 題', bank.body.pagination.total === 6, `total=${bank.body.pagination.total}`);

  console.log('\n=== 建立場次：範圍、題數與順序 ===');
  const noMatch = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'question_group', refId: emptyGroup.body.id }] }, H());
  check('空題組 → 422 QUIZ_NO_QUESTIONS_MATCHED',
    noMatch.status === 422 && noMatch.body.error.code === 'QUIZ_NO_QUESTIONS_MATCHED',
    `status=${noMatch.status}`);

  const badScope = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'subject', refId: '00000000-0000-4000-8000-000000000000' }] }, H());
  check('不存在的科目 → 404 SUBJECT_NOT_FOUND',
    badScope.status === 404 && badScope.body.error.code === 'SUBJECT_NOT_FOUND', `status=${badScope.status}`);

  const noScope = await call('POST', '/quiz-sessions', { scopes: [] }, H());
  check('沒有範圍也沒有錯題 → 400 驗證失敗', noScope.status === 400, `status=${noScope.status}`);

  const bySubject = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'subject', refId: subject.body.id }] }, H());
  check('由科目建立場次 → 6 題', bySubject.body?.totalQuestions === 6, `n=${bySubject.body?.totalQuestions}`);

  const byChapter = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'chapter', refId: chapter.body.id }] }, H());
  check('由章節建立場次 → 6 題', byChapter.body?.totalQuestions === 6);

  const limited = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'question_group', refId: group.body.id }], questionLimit: 3 }, H());
  check('題數上限 3 → 只出 3 題', limited.body?.totalQuestions === 3, `n=${limited.body?.totalQuestions}`);
  check('場次帶回範圍名稱', limited.body?.scopes?.[0]?.refName === '作答測試題組');

  // 順序出題必須依題號；隨機出題必須包含同一批題目但順序不同
  const seqNumbers = [];
  for (let p = 1; p <= 6; p += 1) {
    const q = await call('GET', `/quiz-sessions/${bySubject.body.id}/questions/${p}`);
    seqNumbers.push(q.body.questionNumber);
  }
  check('sequential 依題庫順序出題', JSON.stringify(seqNumbers) === JSON.stringify([1, 2, 3, 4, 5, 6]),
    JSON.stringify(seqNumbers));

  let randomDiffers = false;
  for (let attempt = 0; attempt < 5 && !randomDiffers; attempt += 1) {
    const randomSession = await call('POST', '/quiz-sessions',
      { scopes: [{ scopeType: 'subject', refId: subject.body.id }], orderStrategy: 'random' }, H());
    const nums = [];
    for (let p = 1; p <= 6; p += 1) {
      nums.push((await call('GET', `/quiz-sessions/${randomSession.body.id}/questions/${p}`)).body.questionNumber);
    }
    check(`random 第 ${attempt + 1} 次仍包含全部 6 題`,
      JSON.stringify([...nums].sort((a, b) => a - b)) === JSON.stringify([1, 2, 3, 4, 5, 6]), JSON.stringify(nums));
    if (JSON.stringify(nums) !== JSON.stringify([1, 2, 3, 4, 5, 6])) randomDiffers = true;
  }
  check('random 至少一次真的改變了順序', randomDiffers);

  console.log('\n=== 選項隨機：顯示順序改變，判分仍正確 ===');
  let shuffledSomewhere = false;
  const shuffled = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'question_group', refId: group.body.id }], shuffleOptions: true }, H());
  for (let p = 1; p <= 6; p += 1) {
    const q = await call('GET', `/quiz-sessions/${shuffled.body.id}/questions/${p}`);
    const keys = q.body.options.map((o) => o.key);
    if (keys.join('') !== 'ABCD') shuffledSomewhere = true;
    check(`第 ${p} 題選項完整（打亂後仍是 A~D）`,
      JSON.stringify([...keys].sort()) === JSON.stringify(['A', 'B', 'C', 'D']), keys.join(''));
    check(`第 ${p} 題選項不含 isCorrect`, q.body.options.every((o) => !('isCorrect' in o)));
  }
  check('至少一題的選項順序真的被打亂', shuffledSomewhere);

  // 在打亂的場次中送出真實代號，判分必須正確
  const shuffledQ1 = await call('GET', `/quiz-sessions/${shuffled.body.id}/questions/1`);
  const shuffledAnswer = await call('POST', `/quiz-sessions/${shuffled.body.id}/answers`,
    { sessionQuestionId: shuffledQ1.body.sessionQuestionId, selectedAnswers: ['B'], responseTimeMs: 4200 }, H());
  check('選項打亂後選 B 仍判為答對', shuffledAnswer.body?.reveal?.isCorrect === true,
    JSON.stringify(shuffledAnswer.body));

  console.log('\n=== 即答模式（immediate）===');
  const immediate = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'question_group', refId: group.body.id }], revealMode: 'immediate' }, H());
  const sid = immediate.body.id;

  const q1 = await call('GET', `/quiz-sessions/${sid}/questions/1`);
  check('作答前 reveal 為 null（即答模式也不預先給答案）', q1.body.reveal === null);
  check('作答前無答案洩漏', findAnswerLeaks(q1.body).length === 0, JSON.stringify(findAnswerLeaks(q1.body)));

  const wrong = await call('POST', `/quiz-sessions/${sid}/answers`,
    { sessionQuestionId: q1.body.sessionQuestionId, selectedAnswers: ['A'], responseTimeMs: 3000 }, H());
  check('答錯 → isCorrect = false', wrong.body?.reveal?.isCorrect === false, JSON.stringify(wrong.body));
  check('答錯 → 立即揭露正確答案 B', JSON.stringify(wrong.body?.reveal?.correctAnswers) === '["B"]');
  check('沒有解析的題目 explanation 仍為 null（不編造）', wrong.body?.reveal?.explanation === null);
  check('回傳作答進度', wrong.body?.answeredCount === 1 && wrong.body?.totalQuestions === 6);

  const q2 = await call('GET', `/quiz-sessions/${sid}/questions/2`);
  const right = await call('POST', `/quiz-sessions/${sid}/answers`,
    { sessionQuestionId: q2.body.sessionQuestionId, selectedAnswers: ['A'], responseTimeMs: 2500 }, H());
  check('答對 → isCorrect = true', right.body?.reveal?.isCorrect === true);

  // 跳題導覽列。此刻的狀態：第 1 題答錯、第 2 題答對、其餘未作答。
  const outline = await call('GET', `/quiz-sessions/${sid}/outline`);
  check('導覽列回傳整場題目', outline.status === 200 && outline.body.items.length === 6,
    `status=${outline.status} n=${outline.body?.items?.length}`);
  check('導覽列依 position 排序',
    outline.body.items.every((item, i) => item.position === i + 1),
    JSON.stringify(outline.body.items.map((i) => i.position)));
  check('導覽列標出已作答與未作答',
    outline.body.items[0].answered === true && outline.body.items[2].answered === false,
    JSON.stringify(outline.body.items.map((i) => i.answered)));
  check('即答模式下，已作答的題目在導覽列帶出對錯',
    outline.body.items[0].isCorrect === false && outline.body.items[1].isCorrect === true,
    JSON.stringify(outline.body.items.map((i) => i.isCorrect)));
  // 「還沒作答」與「答錯了」不可以塌縮成同一個值，否則導覽列會把空白題畫成紅的。
  check('**未作答題目的 isCorrect 是 null，不是 false**',
    outline.body.items[2].isCorrect === null,
    `[2].isCorrect=${outline.body.items[2].isCorrect}`);
  check('導覽列不含選項與正確答案',
    outline.body.items.every((item) => item.options === undefined && item.correctAnswers === undefined));
  check('題幹預覽有截斷上限', outline.body.items.every((item) => item.stemPreview.length <= 60),
    JSON.stringify(outline.body.items.map((i) => i.stemPreview.length)));

  const invalidKey = await call('POST', `/quiz-sessions/${sid}/answers`,
    { sessionQuestionId: q2.body.sessionQuestionId, selectedAnswers: ['Z'] }, H());
  check('選項代號不合法 → 400', invalidKey.status === 400, `status=${invalidKey.status}`);

  const q3 = await call('GET', `/quiz-sessions/${sid}/questions/3`);
  const twoOnSingle = await call('POST', `/quiz-sessions/${sid}/answers`,
    { sessionQuestionId: q3.body.sessionQuestionId, selectedAnswers: ['A', 'C'] }, H());
  check('單選題送兩個答案 → 400', twoOnSingle.status === 400 && twoOnSingle.body.error.code === 'VALIDATION_FAILED');

  console.log('\n=== 複選題判分 ===');
  const q6 = await call('GET', `/quiz-sessions/${sid}/questions/6`);
  check('複選題型正確', q6.body.type === 'multiple_choice');

  const partial = await call('POST', `/quiz-sessions/${sid}/answers`,
    { sessionQuestionId: q6.body.sessionQuestionId, selectedAnswers: ['A'] }, H());
  check('複選部分正確 → 不給分', partial.body?.reveal?.isCorrect === false);

  const overPick = await call('POST', `/quiz-sessions/${sid}/answers`,
    { sessionQuestionId: q6.body.sessionQuestionId, selectedAnswers: ['A', 'B', 'C'] }, H());
  check('複選多選 → 不給分', overPick.body?.reveal?.isCorrect === false);

  const reversed = await call('POST', `/quiz-sessions/${sid}/answers`,
    { sessionQuestionId: q6.body.sessionQuestionId, selectedAnswers: ['B', 'A'] }, H());
  check('複選順序相反 → 判為答對（順序無關）', reversed.body?.reveal?.isCorrect === true,
    JSON.stringify(reversed.body?.reveal));
  check('有解析的題目會帶回解析', typeof reversed.body?.reveal?.explanation === 'string');

  console.log('\n=== 交卷後模式（after_submit）：交卷前不得洩漏任何答案 ===');
  const hidden = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'question_group', refId: group.body.id }], revealMode: 'after_submit' }, H());
  const hid = hidden.body.id;

  const hq1 = await call('GET', `/quiz-sessions/${hid}/questions/1`);
  check('取題回應無任何答案欄位', findAnswerLeaks(hq1.body).length === 0,
    JSON.stringify(findAnswerLeaks(hq1.body)));

  const hiddenAnswer = await call('POST', `/quiz-sessions/${hid}/answers`,
    { sessionQuestionId: hq1.body.sessionQuestionId, selectedAnswers: ['A'], responseTimeMs: 1500 }, H());
  check('作答回應 reveal 為 null', hiddenAnswer.body?.reveal === null);
  check('作答回應無任何答案欄位', findAnswerLeaks(hiddenAnswer.body).length === 0,
    JSON.stringify(findAnswerLeaks(hiddenAnswer.body)));

  const afterAnswer = await call('GET', `/quiz-sessions/${hid}/questions/1`);
  check('作答後再取題仍無答案欄位', findAnswerLeaks(afterAnswer.body).length === 0,
    JSON.stringify(findAnswerLeaks(afterAnswer.body)));
  check('但作答內容有保留', JSON.stringify(afterAnswer.body.answer?.selectedAnswers) === '["A"]');

  const hiddenSession = await call('GET', `/quiz-sessions/${hid}`);
  check('場次進度的 correctCount 為 null（數字本身也是洩漏管道）',
    hiddenSession.body.correctCount === null, `correctCount=${hiddenSession.body.correctCount}`);

  // 導覽列是新開的洩漏管道，而且比單題端點更嚴重——一次可以看見全部題目。
  const hiddenOutline = await call('GET', `/quiz-sessions/${hid}/outline`);
  check('**交卷後模式：導覽列整份無任何答案洩漏**',
    findAnswerLeaks(hiddenOutline.body).length === 0,
    JSON.stringify(findAnswerLeaks(hiddenOutline.body)));
  check('**交卷後模式：已作答的題目在導覽列也不給對錯**',
    hiddenOutline.body.items[0].answered === true && hiddenOutline.body.items[0].isCorrect === null,
    JSON.stringify({ answered: hiddenOutline.body.items[0].answered,
      isCorrect: hiddenOutline.body.items[0].isCorrect }));
  check('交卷後模式：導覽列仍可用來跳題（有位置與題號）',
    hiddenOutline.body.items.every((item) => item.position > 0 && item.questionNumber > 0));

  const earlyResult = await call('GET', `/quiz-sessions/${hid}/result`);
  check('交卷前索取結果 → 409 QUIZ_ANSWER_NOT_REVEALED_YET',
    earlyResult.status === 409 && earlyResult.body.error.code === 'QUIZ_ANSWER_NOT_REVEALED_YET',
    `status=${earlyResult.status}`);

  const submitted = await call('POST', `/quiz-sessions/${hid}/submit`, undefined, H());
  check('交卷成功', submitted.status === 200);
  check('交卷後才出現答案', submitted.body.items[0].correctAnswers.length > 0);
  check('未作答題目 isCorrect 為 null（與答錯區分）',
    submitted.body.items[1].isCorrect === null && submitted.body.items[1].selectedAnswers === null);
  check('未作答視同答錯：6 題只答 1 題且答錯 → 得分 0', submitted.body.score === 0, `score=${submitted.body.score}`);
  check('unansweredCount = 5', submitted.body.unansweredCount === 5);

  const afterSubmitQuestion = await call('GET', `/quiz-sessions/${hid}/questions/1`);
  check('交卷後取題會揭露答案', afterSubmitQuestion.body.reveal !== null);

  const submittedOutline = await call('GET', `/quiz-sessions/${hid}/outline`);
  check('交卷後導覽列才給出對錯', submittedOutline.body.items[0].isCorrect === false,
    `[0].isCorrect=${submittedOutline.body.items[0].isCorrect}`);
  check('交卷後未作答的題目仍是 null（未作答 ≠ 答錯）',
    submittedOutline.body.items[1].isCorrect === null,
    `[1].isCorrect=${submittedOutline.body.items[1].isCorrect}`);

  const resubmit = await call('POST', `/quiz-sessions/${hid}/submit`, undefined, H());
  check('重複交卷 → 409', resubmit.status === 409 && resubmit.body.error.code === 'QUIZ_SESSION_ALREADY_SUBMITTED');

  const answerAfterSubmit = await call('POST', `/quiz-sessions/${hid}/answers`,
    { sessionQuestionId: hq1.body.sessionQuestionId, selectedAnswers: ['B'] }, H());
  check('交卷後再作答 → 409', answerAfterSubmit.status === 409);

  /*
   * 單題的個人標記與註記。
   *
   * 在此之前，一道題目唯一會被「標出來」的方式是答錯。
   * 標記與答案揭露無關，因此**交卷前也要能標**——那正是最想標記的時刻。
   */
  console.log('\n=== 單題個人標記 ===');
  const markQ = hq1.body.questionId;

  const flagged = await call('PUT', `/questions/${markQ}/mark`, { isFlagged: true }, H());
  check('可以標記為重點', flagged.status === 200 && flagged.body?.mark?.isFlagged === true,
    JSON.stringify(flagged.body?.mark));

  const noted = await call('PUT', `/questions/${markQ}/mark`, { note: '這題的但書容易漏看' }, H());
  check('可以加註記', noted.body?.mark?.note === '這題的但書容易漏看',
    JSON.stringify(noted.body?.mark));
  check('**只送註記不會把既有標記清掉**', noted.body?.mark?.isFlagged === true,
    JSON.stringify(noted.body?.mark));

  const unflagged = await call('PUT', `/questions/${markQ}/mark`, { isFlagged: false }, H());
  check('**取消標記不會把註記清掉**',
    unflagged.body?.mark?.isFlagged === false && unflagged.body?.mark?.note !== null,
    JSON.stringify(unflagged.body?.mark));

  const cleared = await call('PUT', `/questions/${markQ}/mark`, { note: null }, H());
  check('**標記與註記都清空後整筆標記消失（不是留一列空殼）**',
    cleared.body?.mark === null, JSON.stringify(cleared.body?.mark));

  await call('PUT', `/questions/${markQ}/mark`, { isFlagged: true, note: '重要' }, H());

  const flaggedList = await call('GET', '/questions?flagged=true&pageSize=50');
  check('可以只列出標為重點的題目',
    flaggedList.body?.items?.some((q) => q.id === markQ),
    `total=${flaggedList.body?.pagination?.total}`);
  const unflaggedList = await call('GET', '/questions?flagged=false&pageSize=50');
  check('未標記篩選不會包含已標記的題目',
    !unflaggedList.body?.items?.some((q) => q.id === markQ));

  /*
   * 標記是新的回應欄位，因此要重驗一次防洩漏。
   *
   * 必須另開一個**尚未交卷**的 after_submit 場次：上面那個 hid 早就交卷了，
   * 交卷後出現 reveal 是正確行為，拿它來驗「不得洩漏」只會驗到自己搞錯前提。
   */
  const markSession = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'question_group', refId: group.body.id }], revealMode: 'after_submit' }, H());
  const markSid = markSession.body.id;
  const markFirst = await call('GET', `/quiz-sessions/${markSid}/questions/1`);
  await call('PUT', `/questions/${markFirst.body.questionId}/mark`,
    { isFlagged: true, note: '交卷前就標起來' }, H());

  const markedQuestion = await call('GET', `/quiz-sessions/${markSid}/questions/1`);
  check('**交卷前就能看到自己的標記**', markedQuestion.body?.mark?.isFlagged === true,
    JSON.stringify(markedQuestion.body?.mark));
  check('**帶標記的取題回應仍然沒有任何答案洩漏**',
    findAnswerLeaks(markedQuestion.body).length === 0,
    JSON.stringify(findAnswerLeaks(markedQuestion.body)));

  const markedOutline = await call('GET', `/quiz-sessions/${markSid}/outline`);
  check('導覽列標出重點題',
    markedOutline.body?.items?.some((i) => i.isFlagged === true),
    JSON.stringify(markedOutline.body?.items?.map((i) => i.isFlagged)));
  check('**帶標記的導覽列仍然沒有任何答案洩漏**',
    findAnswerLeaks(markedOutline.body).length === 0,
    JSON.stringify(findAnswerLeaks(markedOutline.body)));

  const badMark = await call('PUT', '/questions/00000000-0000-4000-8000-000000000000/mark',
    { isFlagged: true }, H());
  check('對不存在的題目設標記 → 404', badMark.status === 404, `status=${badMark.status}`);

  console.log('\n=== 修改答案 ===');
  const changeable = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'question_group', refId: group.body.id }], allowAnswerChange: true }, H());
  const cq1 = await call('GET', `/quiz-sessions/${changeable.body.id}/questions/1`);
  const firstTry = await call('POST', `/quiz-sessions/${changeable.body.id}/answers`,
    { sessionQuestionId: cq1.body.sessionQuestionId, selectedAnswers: ['A'] }, H());
  const patched = await call('PATCH', `/quiz-sessions/${changeable.body.id}/answers/${firstTry.body.answerId}`,
    { selectedAnswers: ['B'] }, H());
  check('PATCH 修改答案成功且改判為答對', patched.status === 200 && patched.body.reveal?.isCorrect === true);

  const afterPatch = await call('GET', `/quiz-sessions/${changeable.body.id}/questions/1`);
  check('修改後只有一筆作答（不會變成兩題）', afterPatch.body.answer.answerChangedCount === 1);
  check('修改後場次仍只算 1 題已作答',
    (await call('GET', `/quiz-sessions/${changeable.body.id}`)).body.answeredCount === 1);

  const locked = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'question_group', refId: group.body.id }], allowAnswerChange: false }, H());
  const lq1 = await call('GET', `/quiz-sessions/${locked.body.id}/questions/1`);
  const lockedFirst = await call('POST', `/quiz-sessions/${locked.body.id}/answers`,
    { sessionQuestionId: lq1.body.sessionQuestionId, selectedAnswers: ['A'] }, H());
  check('禁改模式下第一次作答成功', lockedFirst.status === 200);
  const lockedRetry = await call('POST', `/quiz-sessions/${locked.body.id}/answers`,
    { sessionQuestionId: lq1.body.sessionQuestionId, selectedAnswers: ['B'] }, H());
  check('禁改模式下重複作答 → 409 QUIZ_ANSWER_CHANGE_NOT_ALLOWED',
    lockedRetry.status === 409 && lockedRetry.body.error.code === 'QUIZ_ANSWER_CHANGE_NOT_ALLOWED');
  const lockedPatch = await call('PATCH', `/quiz-sessions/${locked.body.id}/answers/${lockedFirst.body.answerId}`,
    { selectedAnswers: ['B'] }, H());
  check('禁改模式下 PATCH → 409', lockedPatch.status === 409);

  console.log('\n=== 錯題本 ===');
  const q1Id = q1.body.questionId;
  const mistakes = await call('GET', `/mistakes?subjectId=${subject.body.id}&pageSize=50`);
  const record = mistakes.body.items.find((m) => m.questionId === q1Id);
  check('答錯的題目自動進入錯題本', record !== undefined, JSON.stringify(mistakes.body.items.map((m) => m.questionNumber)));
  check('未答錯的題目不會進錯題本',
    mistakes.body.items.every((m) => m.questionNumber !== 2),
    JSON.stringify(mistakes.body.items.map((m) => m.questionNumber)));
  check('錯題初始狀態為 active', record?.masteryState === 'active');

  // 這一題在 immediate、shuffled、changeable（先錯後改對）、locked 場次都作答過。
  // 修改答案後不得重複累加，因此 mistakeCount 必須等於「實際答錯的次數」。
  const detail = await call('GET', `/mistakes/${q1Id}`);
  const wrongAttempts = detail.body.attempts.filter((a) => !a.isCorrect).length;
  check('錯題次數等於實際答錯次數（修改答案不重複累加）',
    detail.body.mistakeCount === wrongAttempts,
    `mistakeCount=${detail.body.mistakeCount} wrongAttempts=${wrongAttempts}`);
  check('總作答次數等於歷次作答筆數',
    detail.body.totalAttempts === detail.body.attempts.length,
    `total=${detail.body.totalAttempts} attempts=${detail.body.attempts.length}`);
  check('錯題詳情含歷次作答與正確答案',
    detail.body.attempts.length > 0 && JSON.stringify(detail.body.correctAnswers) === '["B"]');
  check('歷次作答保有當時的答案快照與題目版本',
    detail.body.attempts.every((a) => Array.isArray(a.correctAnswers) && typeof a.questionVersion === 'number'));

  // 連續答對三次 → mastered，且紀錄不消失
  const beforeMistakeCount = detail.body.mistakeCount;
  for (let i = 0; i < 3; i += 1) {
    const s = await call('POST', '/quiz-sessions',
      { scopes: [{ scopeType: 'question_group', refId: group.body.id }], questionLimit: 1 }, H());
    const q = await call('GET', `/quiz-sessions/${s.body.id}/questions/1`);
    await call('POST', `/quiz-sessions/${s.body.id}/answers`,
      { sessionQuestionId: q.body.sessionQuestionId, selectedAnswers: ['B'] }, H());
  }
  const mastered = await call('GET', `/mistakes/${q1Id}`);
  check('連續答對 3 次 → mastered', mastered.body.masteryState === 'mastered', mastered.body.masteryState);
  check('答對不刪除錯題紀錄（FR-MIS-05）', mastered.status === 200);
  check('答對不會減少累計錯誤次數', mastered.body.mistakeCount === beforeMistakeCount,
    `${mastered.body.mistakeCount} vs ${beforeMistakeCount}`);
  check('isResolved 標記為已重新答對', mastered.body.isResolved === true);
  check('近期正確率有值', typeof mastered.body.recentAccuracy === 'number');

  // 再答錯一次 → 退回 active
  const relapse = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'question_group', refId: group.body.id }], questionLimit: 1 }, H());
  const rq = await call('GET', `/quiz-sessions/${relapse.body.id}/questions/1`);
  await call('POST', `/quiz-sessions/${relapse.body.id}/answers`,
    { sessionQuestionId: rq.body.sessionQuestionId, selectedAnswers: ['C'] }, H());
  const relapsed = await call('GET', `/mistakes/${q1Id}`);
  check('再次答錯 → 退回 active 並累加錯誤次數',
    relapsed.body.masteryState === 'active' && relapsed.body.mistakeCount === beforeMistakeCount + 1,
    `${relapsed.body.masteryState} / ${relapsed.body.mistakeCount}`);
  check('isResolved 不會因為再次答錯而變回 false', relapsed.body.isResolved === true);

  const stats = await call('GET', '/mistakes/stats');
  check('錯題統計可取得', stats.status === 200 && stats.body.total >= 1);
  check('錯題統計含科目分布', Array.isArray(stats.body.bySubject) && stats.body.bySubject.length >= 1);

  const filtered = await call('GET', `/mistakes?subjectId=${subject.body.id}&masteryState=active`);
  check('可依熟練狀態篩選', filtered.body.items.every((m) => m.masteryState === 'active'));

  console.log('\n=== 重新練習錯題 ===');
  // 比對基準必須是「本次測試科目」的錯題數，不是全域統計 ——
  // 資料庫若殘留先前測試的資料，全域數字會比範圍內的錯題多。
  const subjectMistakes = await call('GET', `/mistakes?subjectId=${subject.body.id}&pageSize=100`);
  const expectedMistakes = subjectMistakes.body.pagination.total;
  check('本次科目確實有錯題可重練', expectedMistakes > 0, `n=${expectedMistakes}`);

  const practice = await call('POST', '/mistakes/practice',
    { subjectId: subject.body.id, orderStrategy: 'sequential', shuffleOptions: false }, H());
  check('由錯題建立重練場次', practice.status === 200, JSON.stringify(practice.body)?.slice(0, 200));
  check('重練場次 mode 為 mistake_review', practice.body?.mode === 'mistake_review');
  check('重練場次只包含錯題', practice.body?.totalQuestions === expectedMistakes,
    `${practice.body?.totalQuestions} vs ${expectedMistakes}`);

  const practiceQ = await call('GET', `/quiz-sessions/${practice.body.id}/questions/1`);
  check('重練場次可正常取題', practiceQ.status === 200);

  const onlyMistakes = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'question_group', refId: group.body.id }], onlyMistakes: true }, H());
  check('onlyMistakes 與範圍取交集', onlyMistakes.body?.totalQuestions === expectedMistakes,
    `${onlyMistakes.body?.totalQuestions} vs ${expectedMistakes}`);
  check('場次記錄了 mistake 範圍',
    onlyMistakes.body?.scopes?.some((s) => s.scopeType === 'mistake'),
    JSON.stringify(onlyMistakes.body?.scopes));

  console.log('\n=== 結果與統計 ===');
  const result = await call('GET', `/quiz-sessions/${sid}/result`);
  check('即答模式交卷前即可看結果', result.status === 200);

  // 即答模式的承諾是「答完這題就看得到這題的答案」，不是「看得到整份考卷」。
  // 交卷前呼叫 /result 時，還沒作答的題目必須維持未揭曉。
  const unansweredItems = result.body.items.filter((item) => item.selectedAnswers === null);
  const answeredItems = result.body.items.filter((item) => item.selectedAnswers !== null);
  check('交卷前：已作答的題目已揭曉答案',
    answeredItems.length > 0 && answeredItems.every((item) => item.correctAnswers !== null));
  check('**交卷前：未作答的題目不揭曉正確答案**',
    unansweredItems.every((item) => item.correctAnswers === null),
    JSON.stringify(unansweredItems.map((i) => i.correctAnswers)));
  check('**交卷前：未作答題目的選項不透露對錯**',
    unansweredItems.every((item) => item.options.every((o) => o.isCorrect === null)));
  check('**交卷前：未作答的題目不給解析**',
    unansweredItems.every((item) => item.explanation === null));
  // 結果頁的 AI 解析要靠 answerId 產生個人化錯因分析。
  check('已作答的題目帶有 answerId（供個人化 AI 解析使用）',
    answeredItems.every((item) => typeof item.answerId === 'string'));
  check('未作答的題目 answerId 為 null',
    unansweredItems.every((item) => item.answerId === null));
  const scored = await call('POST', `/quiz-sessions/${sid}/submit`, undefined, H());
  check('交卷回傳完整結果', scored.status === 200 && scored.body.items.length === 6);
  check('省略 scoringMode 時維持舊有行為（all_questions）',
    scored.body.scoringMode === 'all_questions', String(scored.body.scoringMode));
  const expectedScore = Math.round((scored.body.correctCount / 6) * 10000) / 100;
  check('得分 = 答對數 ÷ 總題數', scored.body.score === expectedScore,
    `score=${scored.body.score} expected=${expectedScore}`);
  check('作答正確率以已作答題數為分母',
    scored.body.accuracy === Math.round((scored.body.correctCount / scored.body.answeredCount) * 10000) / 100);
  check('場次本身也記下計分方式',
    (await call('GET', `/quiz-sessions/${sid}`)).body.scoringMode === 'all_questions');

  // ---- 提早交卷：只算作答過的部分 ----
  console.log('\n=== 交卷計分方式：可選擇未作答題目算不算 ===');
  const partialSession = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'question_group', refId: group.body.id }] }, H());
  const partialId = partialSession.body.id;
  const partialTotal = partialSession.body.totalQuestions;
  check('新場次題數大於 2（才有未作答的題目可測）', partialTotal > 2, `total=${partialTotal}`);

  // 只答前兩題：第 1 題答對、第 2 題答錯。
  const p1 = await call('GET', `/quiz-sessions/${partialId}/questions/1`);
  await call('POST', `/quiz-sessions/${partialId}/answers`,
    { sessionQuestionId: p1.body.sessionQuestionId, selectedAnswers: ['B'] }, H());
  const p2 = await call('GET', `/quiz-sessions/${partialId}/questions/2`);
  await call('POST', `/quiz-sessions/${partialId}/answers`,
    { sessionQuestionId: p2.body.sessionQuestionId, selectedAnswers: ['A'] }, H());

  const earlySubmit = await call('POST', `/quiz-sessions/${partialId}/submit`,
    { scoringMode: 'answered_only' }, H());
  check('可指定只算作答過的部分', partial.status === 200, `status=${partial.status}`);
  check('回應標明計分方式', earlySubmit.body.scoringMode === 'answered_only',
    String(earlySubmit.body.scoringMode));
  check('已作答 2 題', earlySubmit.body.answeredCount === 2, String(earlySubmit.body.answeredCount));
  check('未作答題數正確', earlySubmit.body.unansweredCount === partialTotal - 2,
    String(earlySubmit.body.unansweredCount));
  check('**分母是已作答題數，不是總題數**',
    earlySubmit.body.score === Math.round((earlySubmit.body.correctCount / 2) * 10000) / 100,
    `score=${earlySubmit.body.score} correct=${earlySubmit.body.correctCount}`);
  // 這是這個功能的重點：未作答的題目不該把分數拉低。
  check('**未作答的題目沒有把分數拉低**',
    earlySubmit.body.score > Math.round((earlySubmit.body.correctCount / partialTotal) * 10000) / 100,
    `answered_only=${earlySubmit.body.score} vs all_questions=${Math.round((earlySubmit.body.correctCount / partialTotal) * 10000) / 100}`);
  check('正確率與計分方式無關（一律以已作答為分母）',
    earlySubmit.body.accuracy === Math.round((earlySubmit.body.correctCount / 2) * 10000) / 100,
    String(earlySubmit.body.accuracy));

  // 重看結果頁時分數必須與交卷當下一致，不能因為預設值而漂移。
  const earlyAgain = await call('GET', `/quiz-sessions/${partialId}/result`);
  check('**重看結果頁的分數與交卷當下一致**',
    earlyAgain.body.score === earlySubmit.body.score,
    `${earlySubmit.body.score} → ${earlyAgain.body.score}`);
  check('重看結果頁的計分方式也一致',
    earlyAgain.body.scoringMode === 'answered_only');
  check('場次列表也帶出計分方式',
    (await call('GET', `/quiz-sessions/${partialId}`)).body.scoringMode === 'answered_only');

  check('不合法的 scoringMode → 400',
    (await call('POST', `/quiz-sessions/${partialId}/submit`, { scoringMode: 'nonsense' }, H()))
      .status === 400);
  check('有記錄總作答時間', typeof scored.body.durationMs === 'number');
  check('有記錄平均作答時間', typeof scored.body.averageResponseTimeMs === 'number');

  const abandonTarget = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'question_group', refId: group.body.id }] }, H());
  const abandoned = await call('POST', `/quiz-sessions/${abandonTarget.body.id}/abandon`, undefined, H());
  check('可放棄場次', abandoned.status === 200 && abandoned.body.status === 'abandoned');

  const list = await call('GET', '/quiz-sessions?pageSize=5');
  check('可列出場次歷史', list.status === 200 && list.body.items.length > 0);
  const inProgressOnly = await call('GET', '/quiz-sessions?status=submitted&pageSize=50');
  check('可依狀態篩選場次', inProgressOnly.body.items.every((s) => s.status === 'submitted'));

  const overview = await call('GET', '/stats/overview');
  check('學習概況可取得', overview.status === 200);
  check('概況含題庫規模', overview.body.questionCount >= 6);
  check('概況含正確率', typeof overview.body.accuracy === 'number');
  check('概況含錯題統計', overview.body.mistakeTotal >= 1);
  check('概況含近期場次', Array.isArray(overview.body.recentSessions) && overview.body.recentSessions.length > 0);
  check('概況含各科目表現', overview.body.bySubject.some((s) => s.subjectId === subject.body.id));

  console.log('\n=== 權限與錯誤處理 ===');
  const notFound = await call('GET', '/quiz-sessions/00000000-0000-4000-8000-000000000000');
  check('不存在的場次 → 404 QUIZ_SESSION_NOT_FOUND',
    notFound.status === 404 && notFound.body.error.code === 'QUIZ_SESSION_NOT_FOUND');

  const badPosition = await call('GET', `/quiz-sessions/${sid}/questions/999`);
  check('超出範圍的題號 → 404', badPosition.status === 404);

  const noCsrf = await call('POST', '/quiz-sessions',
    { scopes: [{ scopeType: 'subject', refId: subject.body.id }] });
  check('缺少 CSRF 標頭 → 403', noCsrf.status === 403, `status=${noCsrf.status}`);

  console.log('\n=== 作答範圍：章節可單選也可多選 ===');
  // 自帶科目：在既有的測試科目裡加題目，會讓後面依賴「正好 6 題」的斷言失效。
  const mcSubject = await call('POST', '/subjects', { name: `多章節測試科目 ${stamp}` }, H());
  const mcChapter1 = await call('POST', '/chapters',
    { subjectId: mcSubject.body.id, name: '第一章' }, H());
  const mcGroup1 = await call('POST', '/question-groups',
    { subjectId: mcSubject.body.id, chapterId: mcChapter1.body.id, name: '第一章題組' }, H());
  for (const n of [1, 2, 3]) {
    await call('POST', '/questions', single(n, 'A', { questionGroupId: mcGroup1.body.id }), H());
  }

  // 多選時範圍取聯集。
  // 後端一直支援 scopes 陣列，但同型範圍給多筆這條路徑從來沒被跑過。
  const mcChapter2 = await call('POST', '/chapters',
    { subjectId: mcSubject.body.id, name: '第二章 行政程序' }, H());
  const mcGroup2 = await call('POST', '/question-groups',
    { subjectId: mcSubject.body.id, chapterId: mcChapter2.body.id, name: '第二章題組' }, H());
  const mcChapter3 = await call('POST', '/chapters',
    { subjectId: mcSubject.body.id, name: '第三章 行政救濟' }, H());
  const mcGroup3 = await call('POST', '/question-groups',
    { subjectId: mcSubject.body.id, chapterId: mcChapter3.body.id, name: '第三章題組' }, H());
  for (const n of [11, 12]) {
    await call('POST', '/questions', single(n, 'A', { questionGroupId: mcGroup2.body.id }), H());
  }
  await call('POST', '/questions', single(21, 'A', { questionGroupId: mcGroup3.body.id }), H());

  const twoChapters = await call('POST', '/quiz-sessions', {
    scopes: [
      { scopeType: 'chapter', refId: mcChapter1.body.id },
      { scopeType: 'chapter', refId: mcChapter2.body.id },
    ],
  }, H());
  check('**多個章節取聯集**（3 + 2 = 5 題）', twoChapters.body?.totalQuestions === 5,
    `n=${twoChapters.body?.totalQuestions}`);
  check('場次記得每一個範圍', twoChapters.body?.scopes?.length === 2,
    JSON.stringify(twoChapters.body?.scopes?.map((s) => s.refName)));

  const threeChapters = await call('POST', '/quiz-sessions', {
    scopes: [
      { scopeType: 'chapter', refId: mcChapter1.body.id },
      { scopeType: 'chapter', refId: mcChapter2.body.id },
      { scopeType: 'chapter', refId: mcChapter3.body.id },
    ],
  }, H());
  check('**三個章節也是聯集而不是交集**（3 + 2 + 1 = 6 題）',
    threeChapters.body?.totalQuestions === 6, `n=${threeChapters.body?.totalQuestions}`);

  // 挑不相鄰的兩章：真的是被選中的那兩章，沒有把中間那章一起掃進來。
  const skipMiddle = await call('POST', '/quiz-sessions', {
    scopes: [
      { scopeType: 'chapter', refId: mcChapter1.body.id },
      { scopeType: 'chapter', refId: mcChapter3.body.id },
    ],
  }, H());
  check('**跳過中間的章節不會被算進來**（3 + 1 = 4 題）',
    skipMiddle.body?.totalQuestions === 4, `n=${skipMiddle.body?.totalQuestions}`);

  const dupChapter = await call('POST', '/quiz-sessions', {
    scopes: [
      { scopeType: 'chapter', refId: mcChapter2.body.id },
      { scopeType: 'chapter', refId: mcChapter2.body.id },
    ],
  }, H());
  check('同一章節送兩次不會出現重複的題目', dupChapter.body?.totalQuestions === 2,
    `status=${dupChapter.status} ${JSON.stringify(dupChapter.body)}`);

  const withBadChapter = await call('POST', '/quiz-sessions', {
    scopes: [
      { scopeType: 'chapter', refId: mcChapter1.body.id },
      { scopeType: 'chapter', refId: '00000000-0000-4000-8000-000000000000' },
    ],
  }, H());
  check('**多選之中夾帶不存在的章節 → 整批擋下**', withBadChapter.status === 404,
    `status=${withBadChapter.status}`);

  console.log(`\n=== Phase 2 結果：${pass} 通過、${fail} 失敗 ===\n`);
  process.exit(fail === 0 ? 0 : 1);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
