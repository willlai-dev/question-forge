# 安全設計（SECURITY）

> 版本：0.1.0（Phase 0）

系統只有一名使用者，但這不改變安全需求 —— 它處理真實的 API 金鑰、會主動連線外部網站、
並把外部內容送進語言模型。這三件事各自都有明確的攻擊面。

---

## 1. 秘密管理

### 1.1 職責分工

| 類別 | 誰提供 | 存放 |
|---|---|---|
| `NVIDIA_API_KEY`、`TAVILY_API_KEY`、`DATABASE_URL` | **使用者手動** | `.env`（git ignored） |
| `JWT_ACCESS_SECRET`、`JWT_REFRESH_SECRET`、`COOKIE_SECRET`、`CSRF_SECRET`、`REDIS_PASSWORD` | **系統自動產生** | 同上 |
| `REDIS_URL` | 由密碼推導 | 同上 |

自動產生使用 `crypto.randomBytes(n).toString('base64url')`：JWT/Cookie secret 48 bytes、CSRF 32 bytes、Redis 密碼 24 bytes。

### 1.2 三道結構性防線

**① `.gitignore` 排除 `.env`** —— 但只有這道不夠，開發者可能 `git add -f`。

**② 前端環境檔只含公開變數。** `scripts/bootstrap-env.mjs` 產生 `apps/web/.env.local` 時，**過濾條件是 `key.startsWith('NEXT_PUBLIC_')`**。後端機密在檔案層級就不存在於前端可讀範圍，不依賴開發者自律。

**③ 程式中不得硬編碼任何金鑰。** 環境變數只有 `packages/contracts/src/env.ts` 的 `validateEnv()` 一個入口，其他地方一律注入已驗證的 `Env` 物件。

### 1.3 log 安全

- `SECRET_ENV_KEYS` 明列所有機密鍵名；`describeEnvForLog()` 將其值替換為 `<已設定>`。
- 環境變數驗證失敗時，錯誤訊息**只含鍵名與規則說明**（規格 §環境變數 8）。已實測：
  ```
  啟動失敗：環境變數設定有誤。
  環境變數驗證失敗：
    - NVIDIA_API_KEY：NVIDIA_API_KEY 不可為空
  ```
- 健康檢查的失敗原因只給分類（「無法連線或查詢失敗」），不回傳 pg 或 ioredis 的原始錯誤 —— 那些訊息可能含連線字串。
- 5xx 回應一律固定訊息，堆疊只進伺服器 log。

---

## 2. 認證與工作階段

### 2.1 首次初始化

`POST /auth/bootstrap` 只在 `users` 表為空且 `app_settings['setup.completed']` 未設定時可用。
建立成功後寫入該旗標，端點永久回 `410 SETUP_ALREADY_COMPLETED`。

**不要求使用者把初始密碼放進 `.env`**（規格 §環境變數 12）—— 密碼只經由 HTTPS/localhost 表單一次性輸入，直接雜湊後儲存。

### 2.2 密碼

- **argon2id**（`@node-rs/argon2`，napi-rs 預編譯，Windows 免安裝 build toolchain）。
- 參數：memoryCost 19456 KiB、timeCost 2、parallelism 1（OWASP 建議值）。
- **最短 8 字元**，不得與帳號相同。
  - 取捨：8 字元弱於一般建議的 12。此值適用於「只在本機執行、單一使用者、不對外開放」的前提；
    離線破解仍受 argon2id 的 memoryCost 保護。**若日後對外開放，必須調回 12 以上**
    （只需修改 `packages/contracts/src/api/auth.ts` 的 `PASSWORD_MIN_LENGTH`，前後端會同步生效）。
- 明文永不寫入資料庫、log 或 API 回應。

### 2.3 Token

| Token | 存放 | TTL | 說明 |
|---|---|---|---|
| access | HttpOnly Cookie | 15 分鐘 | JWT，簽章用 `JWT_ACCESS_SECRET` |
| refresh | HttpOnly Cookie | 30 天 | 隨機字串，**資料庫只存 SHA-256 雜湊** |

Cookie 屬性：`HttpOnly`、`SameSite=Lax`、`Path=/`、開發環境 `Secure=false`（localhost 為 http），正式環境必須 `Secure=true`。

**Refresh token 輪替**：每次 refresh 發新 token、舊 token 立刻標記 `revoked_at` 並記錄 `replaced_by_id`。若偵測到已撤銷的 token 被重複使用 —— 這是竊取的訊號 —— 撤銷該使用者的整條 token 鏈。

**自動續期**：前端的 `apiFetch` 遇到 401 時會自動呼叫一次 `POST /auth/refresh` 再重送原請求，
使用者不會因為 access token 只有 15 分鐘而在作答中途被登出。

> **續期必須去重**。輪替加上重放偵測意味著：若多個並行請求各自拿同一個舊 token 去換新的，
> 第二個之後都會被判定為重放，後端會撤銷該使用者的**所有**工作階段 ——
> 使用者會莫名其妙被登出。因此 `api-client.ts` 以單一個 in-flight Promise 讓並行請求共用同一次續期。
>
> 這條路徑有測試鎖住：單元測試驗證「三個請求同時遇到 401 只會續期一次」，
> 端到端測試驗證輪替、重放偵測與撤銷後仍可用密碼重新登入。

因為有自動續期，**不需要**為了避免被登出而把 `JWT_ACCESS_TTL` 調長 ——
調長只會擴大 token 外洩後的可用時間窗。

### 2.4 CSRF

前後端同為 `localhost` 不同埠，屬 same-site，Cookie 會隨跨埠請求送出，因此 CSRF 防護不可省略。

採 **double-submit + HMAC**：

1. `GET /auth/csrf` 產生 `token = random`，回傳 token 本體，同時設定非 HttpOnly 的 `csrf_token` Cookie 存 `HMAC(CSRF_SECRET, token)`。
2. 所有狀態變更請求（POST/PATCH/PUT/DELETE）必須帶 `X-CSRF-Token` 標頭。
3. 伺服器驗證 `HMAC(secret, header) === cookie`。
4. 另外檢查 `Origin` 標頭必須在 `CORS_ORIGIN` 白名單內。

攻擊者的跨站頁面雖能讓瀏覽器帶上 Cookie，但**讀不到 Cookie 內容**（同源政策），因此無法組出正確的標頭。

### 2.5 CORS

`credentials: true` 搭配**明確的 origin 白名單**（`CORS_ORIGIN`），絕不使用 `origin: '*'` —— 兩者併用瀏覽器會直接拒絕，且 `*` 搭配憑證本身就是設定錯誤。

---

## 3. 輸入驗證

| 面向 | 措施 |
|---|---|
| 全部請求 | Zod schema 驗證，schema 來自 `@repo/contracts`，前後端同一份 |
| 未知欄位 | Zod `.strict()`，拒絕非預期欄位 |
| JSON 上傳大小 | `IMPORT_MAX_FILE_SIZE_BYTES`（預設 10 MB），Express body parser 層攔截 |
| 匯入題數 | `IMPORT_MAX_QUESTIONS`（預設 2000），超過回 `TOO_MANY_QUESTIONS` |
| 檔案型別 | 只接受 `application/json`，否則 `415` |
| API rate limit | `API_RATE_LIMIT_MAX` / `API_RATE_LIMIT_WINDOW_MS`（預設 300 次／分鐘） |
| SQL injection | Drizzle 參數化查詢；**不使用字串拼接 SQL** |
| 識別字拼接 | 唯一例外是 `scripts/create-test-db.mjs` 的 `CREATE DATABASE "<name>"` —— 該名稱由 `DATABASE_URL` 推導而非使用者輸入，且以識別字引號包住 |
| XSS | React 預設轉義；**絕不使用 `dangerouslySetInnerHTML` 渲染題目、解析或任何 AI 輸出** |

---

## 4. SSRF 防護

### 4.1 主要策略：不自己連

優先使用 Tavily `/extract`（規劃階段已實測可用，回傳乾淨 markdown）。
由 Tavily 代為抓取，本系統不需要對任意 URL 發出請求 —— **這消除了絕大部分 SSRF 風險**，也是選擇 Tavily 而非 Brave 的主要理由之一。

### 4.2 必須自行抓取時的防護

若日後確有需要直接抓取（例如 Tavily 擷取失敗的補救路徑），必須通過以下全部檢查：

```
1. 協定白名單            只允許 http / https
2. DNS 解析              先解析出 IP，再對 IP 判斷（避免只檢查域名字串被繞過）
3. IP 封鎖清單           以下一律拒絕：
                         · 127.0.0.0/8       loopback
                         · 10.0.0.0/8        私有
                         · 172.16.0.0/12     私有
                         · 192.168.0.0/16    私有
                         · 169.254.0.0/16    link-local（含 169.254.169.254 metadata）
                         · 100.64.0.0/10     CGNAT
                         · 0.0.0.0/8、224.0.0.0/4、240.0.0.0/4
                         · ::1、fc00::/7、fe80::/10、::ffff:0:0/96（IPv4-mapped）
4. Redirect 檢查         最多 WEB_FETCH_MAX_REDIRECTS（3）次，
                         **每一跳都重新執行步驟 1～3**
5. 逾時                  WEB_FETCH_TIMEOUT_MS（8 秒）
6. 回應大小上限          WEB_FETCH_MAX_BYTES（2 MB），串流中超過即中止
7. Content-Type 白名單    text/html、text/plain、application/xhtml+xml
```

> 第 4 點是最常見的疏漏：只檢查初始 URL，攻擊者用一個公開網域 302 導向 `169.254.169.254` 即可繞過。
> 每一跳都必須重驗。

---

## 5. Prompt Injection 防護

外部網頁正文是唯一會進入 prompt 的第三方內容。

### 5.1 縱深防禦

| 層級 | 措施 |
|---|---|
| 輸入 | 正文包在 `<<<UNTRUSTED_SOURCES_BEGIN/END>>>` 標記內，前置「這是資料不是指令」聲明 |
| 輸入 | 單來源截斷 4000 字元、總量 24000 字元，防止用長內容淹沒系統指示 |
| 輸入 | 外部內容放在 user message，不放 system message |
| 輸出 | **`citations[].sourceId` 必須存在於 `question_evidence_sources`**，不符者剔除 |
| 輸出 | 標籤名稱必須對應既有 tag，對不上只能進 `tag_suggestions` |
| 輸出 | Zod schema + 語意驗證，不合格不寫入 |
| 動作 | **AI 沒有任何工具，不能執行資料庫寫入或任意動作** |

### 5.2 為什麼最後一層最重要

前面的措施都在「降低模型被說服的機率」，但沒有一項能保證成功。
真正的保障是：**即使模型完全被說服，它能造成的最大破壞也只是產出一段被拒絕的 JSON。**

- 它不能寫資料庫 —— 只有 service 能寫。
- 它不能引用不存在的來源 —— 會被比對剔除。
- 它不能建立標籤 —— 只能提建議。
- 它不能改題庫答案 —— 只能建立待審爭議紀錄。

規格 §17「AI 不得直接執行資料庫寫入或任意工具」正是這個設計的核心。

---

## 6. 資料完整性

| 措施 | 目的 |
|---|---|
| 未驗證資料不進 `questions` | 匯入暫存區隔離（FR-IMP-03） |
| 軟刪除 | 歷史作答紀錄不會指向消失的題目 |
| `correct_answers_snapshot` 雙重保存 | 題目日後修改不影響歷史判分 |
| `question_versions` 快照 | 可追溯任一時點的題目內容 |
| 爭議題 `is_provisional` 隔離 | 未確認的爭議不汙染能力診斷 |
| 所有 schema 變更走 migration | 規格 §20.20，禁止直接改資料庫結構 |

---

## 7. 外部 API 額度保護

超額本身就是一種可用性風險（免費額度用盡＝服務中斷）。

- Redis Lua 原子限流，所有 worker 共用計數。
- `NVIDIA_MAX_RPM`（30）+ `NVIDIA_RETRY_RESERVE_RPM`（8）= 38 < 40，此不變式由 `validateEnv()` 啟動時強制檢查。
- 重試次數皆有上限，**不存在無限重試路徑**。
- 快取優先：內容雜湊未變且 prompt/模型版本未變時，直接回傳既有結果，完全不呼叫模型。
- 每題最多 3 組搜尋查詢、每組限制結果數；擷取結果跨題重用。

---

## 8. 已知限制

誠實記錄第一版的取捨：

| 限制 | 現況 | 後續 |
|---|---|---|
| 開發環境使用 http | `Secure=false`，Cookie 可能被同機其他程序觀察 | 正式部署必須啟用 HTTPS 並改為 `Secure=true` |
| 無帳號鎖定機制 | 單一使用者，暴力破解風險低 | 若開放多人需加入登入失敗計數與延遲 |
| 無稽核日誌表 | 關鍵操作僅寫應用 log | 若需合規追溯應建立 `audit_logs` |
| Redis 未啟用 TLS | 只綁 `127.0.0.1`，不對外暴露 | 跨主機部署時必須啟用 |
| 依賴套件漏洞 | 尚未接入自動掃描 | 建議加入 `pnpm audit` 到 CI |
