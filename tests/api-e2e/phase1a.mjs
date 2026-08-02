/**
 * Phase 1a 端到端行為驗證。
 * 以 Node fetch 執行，避免 Git Bash 的字碼頁轉換與 /tmp 路徑歧義污染結果。
 */
const BASE = process.env.BASE ?? 'http://localhost:4101/api/v1';

// 名稱在使用者範圍內唯一，因此固定名稱會讓第二次執行撞上 409。
// 加上每次執行的戳記，讓同一個資料庫可以重複跑。
const stamp = Date.now().toString(36);
const T = (name) => `${name}-${stamp}`;

const jar = new Map();
let pass = 0;
let fail = 0;

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 吸收 Set-Cookie，並回傳這次被重新下發的 cookie 名稱（供續期測試斷言）。 */
function absorb(res) {
  const names = [];
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const idx = pair.indexOf('=');
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    names.push(name);
    if (value === '' ) jar.delete(name);
    else jar.set(name, value);
  }
  return names;
}

async function call(method, path, body, extraHeaders = {}) {
  const headers = { Cookie: cookieHeader(), ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = absorb(res);
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, body: json, set };
}

function check(label, condition, detail = '') {
  if (condition) { pass += 1; console.log(`  ✔ ${label}`); }
  else { fail += 1; console.log(`  ✘ ${label} ${detail}`); }
}

let csrf = '';
async function refreshCsrf() {
  const r = await call('GET', '/auth/csrf');
  csrf = r.body.csrfToken;
}
const H = () => ({ 'X-CSRF-Token': csrf });

const run = async () => {
  console.log('\n=== 認證 ===');
  await refreshCsrf();

  const status = await call('GET', '/auth/bootstrap');
  check('初始化狀態端點可用', status.status === 200);
  if (status.body.canBootstrap) {
    const created = await call('POST', '/auth/bootstrap',
      { username: 'probe', password: 'probe-password-123', confirmPassword: 'probe-password-123', displayName: '測試使用者' }, H());
    check('首次初始化成功', created.status === 201, JSON.stringify(created.body));
    check('displayName 中文往返正確', created.body?.displayName === '測試使用者', `實際: ${created.body?.displayName}`);

    const again = await call('POST', '/auth/bootstrap',
      { username: 'other', password: 'another-password-1', confirmPassword: 'another-password-1' }, H());
    check('再次初始化 → 410 SETUP_ALREADY_COMPLETED',
      again.status === 410 && again.body.error.code === 'SETUP_ALREADY_COMPLETED');

    const statusAfter = await call('GET', '/auth/bootstrap');
    check('初始化後 canBootstrap 為 false', statusAfter.body.canBootstrap === false);
  }

  const login = await call('POST', '/auth/login', { username: 'probe', password: 'probe-password-123' }, H());
  check('登入成功（HTTP 200）', login.status === 200, `status=${login.status}`);

  const me = await call('GET', '/auth/me');
  check('GET /auth/me 回傳使用者', me.status === 200 && me.body.username === 'probe');

  const wrongPw = await call('POST', '/auth/login', { username: 'probe', password: 'wrong-password-x' }, H());
  check('錯誤密碼回 401 INVALID_CREDENTIALS', wrongPw.status === 401 && wrongPw.body.error.code === 'INVALID_CREDENTIALS');

  const noCsrf = await call('POST', '/subjects', { name: 'x'.repeat(5) });
  check('缺少 CSRF 標頭回 403', noCsrf.status === 403 && noCsrf.body.error.code === 'CSRF_TOKEN_INVALID');

  console.log('\n=== 中文編碼往返 ===');
  const s1 = await call('POST', '/subjects', { name: T('行政法'), code: `ADMIN${stamp}`, description: '中文描述測試' }, H());
  check('建立中文名稱科目', s1.status === 201, JSON.stringify(s1.body));
  check('name 往返正確（行政法）', s1.body?.name === T('行政法'), `實際: ${s1.body?.name}`);
  check('description 往返正確', s1.body?.description === '中文描述測試', `實際: ${s1.body?.description}`);

  const s2 = await call('POST', '/subjects', { name: T('民法') }, H());
  check('建立第二個科目', s2.status === 201);

  console.log('\n=== 階層約束 ===');
  const c1 = await call('POST', '/chapters', { subjectId: s1.body.id, name: '第三章 行政行為' }, H());
  check('在科目A下建立章節', c1.status === 201 && c1.body.name === '第三章 行政行為');

  const g1 = await call('POST', '/question-groups', { subjectId: s1.body.id, chapterId: c1.body.id, name: '112年地特三等', source: '112地特', year: 2023 }, H());
  check('題組掛在同科目的章節下 → 成功', g1.status === 201, JSON.stringify(g1.body));

  const gBad = await call('POST', '/question-groups', { subjectId: s2.body.id, chapterId: c1.body.id, name: '跨科目題組' }, H());
  check('題組引用他科目章節 → 409 CHAPTER_SUBJECT_MISMATCH',
    gBad.status === 409 && gBad.body.error.code === 'CHAPTER_SUBJECT_MISMATCH', JSON.stringify(gBad.body));

  const gNull = await call('POST', '/question-groups', { subjectId: s1.body.id, chapterId: null, name: '無章節題組' }, H());
  check('題組不指定章節 → 成功（章節可為空）', gNull.status === 201 && gNull.body.chapterId === null);

  const dupSubject = await call('POST', '/subjects', { name: T('行政法') }, H());
  check('同名科目 → 409 CONFLICT', dupSubject.status === 409 && dupSubject.body.error.code === 'CONFLICT');

  console.log('\n=== 查詢與篩選 ===');
  // 一律限定在本次執行建立的科目底下，否則第二次執行會被前一次的資料墊高。
  const listAll = await call('GET', `/question-groups?subjectId=${s1.body.id}&page=1&pageSize=20`);
  check('題組列表含分頁', listAll.status === 200 && listAll.body.pagination.total === 2, JSON.stringify(listAll.body?.pagination));

  const listNone = await call('GET', `/question-groups?subjectId=${s1.body.id}&chapterId=none`);
  check('chapterId=none 只回無章節題組',
    listNone.status === 200 && listNone.body.items.length === 1 && listNone.body.items[0].chapterId === null);

  const subjects = await call('GET', '/subjects');
  const admin = subjects.body.find((s) => s.name === T('行政法'));
  check('科目列表帶出章節數', admin?.chapterCount === 1, `chapterCount=${admin?.chapterCount}`);
  check('科目列表帶出題組數', admin?.questionGroupCount === 2, `questionGroupCount=${admin?.questionGroupCount}`);

  console.log('\n=== 排序 ===');
  // 斷言兩者的「相對」順序而非絕對位置，資料庫裡還有沒有別的科目都不影響。
  const names = (list) => (list ?? []).map((s) => s.name);
  const beforeNames = names(subjects.body);
  const beforeIdx = beforeNames.indexOf(T('民法')) < beforeNames.indexOf(T('行政法'));
  const reordered = await call('POST', '/subjects/reorder', { orderedIds: [s2.body.id, s1.body.id] }, H());
  check('重新排序成功', reordered.status === 201 || reordered.status === 200, `status=${reordered.status}`);
  const afterNames = names(reordered.body);
  check('順序已改變（民法排到行政法之前）',
    !beforeIdx && afterNames.indexOf(T('民法')) < afterNames.indexOf(T('行政法')),
    `before=${beforeNames} after=${afterNames}`);

  const badReorder = await call('POST', '/subjects/reorder', { orderedIds: [s1.body.id, s1.body.id] }, H());
  check('重複 ID 的排序 → 400', badReorder.status === 400, JSON.stringify(badReorder.body?.error?.code));

  console.log('\n=== 刪除語意 ===');
  const delChapter = await call('DELETE', `/chapters/${c1.body.id}`, undefined, H());
  check('刪除章節成功', delChapter.status === 200);

  const groupAfter = await call('GET', `/question-groups/${g1.body.id}`);
  check('章節刪除後題組仍存在', groupAfter.status === 200);
  check('題組退回直接隸屬科目（chapterId=null）', groupAfter.body?.chapterId === null, `chapterId=${groupAfter.body?.chapterId}`);

  const delSubject = await call('DELETE', `/subjects/${s1.body.id}`, undefined, H());
  check('刪除科目成功', delSubject.status === 200);
  const groupGone = await call('GET', `/question-groups/${g1.body.id}`);
  check('科目刪除後題組連帶軟刪除 → 404', groupGone.status === 404);

  const recreate = await call('POST', '/subjects', { name: T('行政法') }, H());
  check('軟刪除後可重建同名科目', recreate.status === 201, JSON.stringify(recreate.body));

  console.log('\n=== 未認證存取 ===');
  const saved = new Map(jar);
  jar.clear();
  const anon = await call('GET', '/subjects');
  check('未登入存取 → 401 UNAUTHORIZED', anon.status === 401 && anon.body.error.code === 'UNAUTHORIZED');
  for (const [k, v] of saved) jar.set(k, v);

  // 這段原本沒有覆蓋。前端在 access token 過期時會自動呼叫此端點續期
  // （否則作答超過 15 分鐘就會被踢回登入頁），因此它已是關鍵路徑，必須測。
  console.log('\n=== Token 續期與重放偵測 ===');
  const decodeJwt = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  const oldRefresh = jar.get('refresh_token');
  const oldAccess = jar.get('access_token');
  check('登入後同時取得 access 與 refresh cookie', Boolean(oldRefresh && oldAccess));

  const renewed = await call('POST', '/auth/refresh', undefined, H());
  check('POST /auth/refresh → 200', renewed.status === 200, `status=${renewed.status}`);
  check('續期後重新下發兩個 cookie',
    renewed.set.includes('access_token') && renewed.set.includes('refresh_token'),
    renewed.set.join(','));
  check('refresh token 已輪替', jar.get('refresh_token') !== oldRefresh);
  check('續期後的 access token 仍屬同一使用者',
    decodeJwt(jar.get('access_token')).sub === decodeJwt(oldAccess).sub);

  const stillWorks = await call('GET', '/auth/me');
  check('續期後可繼續存取受保護資源', stillWorks.status === 200);

  // 重放：拿已輪替掉的舊 token 再換一次
  const currentRefresh = jar.get('refresh_token');
  jar.set('refresh_token', oldRefresh);
  const replay = await call('POST', '/auth/refresh', undefined, H());
  check('舊 refresh token 重放 → 401 REFRESH_TOKEN_INVALID',
    replay.status === 401 && replay.body?.error?.code === 'REFRESH_TOKEN_INVALID',
    `status=${replay.status} code=${replay.body?.error?.code}`);

  // 偵測到重放後，該使用者的所有工作階段都應被撤銷 —— 連原本合法的新 token 也不能再用
  jar.set('refresh_token', currentRefresh);
  const afterReplay = await call('POST', '/auth/refresh', undefined, H());
  check('偵測到重放後，連合法的新 token 也一併失效',
    afterReplay.status === 401, `status=${afterReplay.status}`);

  // 後續測試需要有效登入狀態
  await refreshCsrf();
  const relogin = await call('POST', '/auth/login',
    { username: 'probe', password: 'probe-password-123' }, H());
  check('重放撤銷後仍可用密碼重新登入', relogin.status === 200 || relogin.status === 201,
    `status=${relogin.status}`);

  console.log('\n=== 登出 ===');
  await refreshCsrf();
  const logout = await call('POST', '/auth/logout', undefined, H());
  check('登出成功', logout.status === 201 || logout.status === 200, `status=${logout.status}`);
  const afterLogout = await call('GET', '/auth/me');
  check('登出後 /auth/me → 401', afterLogout.status === 401);

  console.log(`\n===== 通過 ${pass} 項，失敗 ${fail} 項 =====`);
  process.exit(fail === 0 ? 0 : 1);
};

run().catch((e) => { console.error('測試執行失敗：', e); process.exit(1); });
