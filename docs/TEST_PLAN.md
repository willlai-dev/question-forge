# 測試計畫（TEST_PLAN）

> 版本：0.1.0（Phase 0）

規格 §18 明令「不得只做 happy path」。本計畫因此對每個項目都同時列出**正常路徑與失敗路徑**。

---

## 1. 測試層級與工具

| 層級 | 工具 | 範圍 | 外部相依 |
|---|---|---|---|
| 單元 | Vitest | 純函式、驗證邏輯、schema | 無 |
| 整合 | Vitest + 真實 PostgreSQL 測試庫 + 真實 Redis | 模組與資料庫互動、佇列 | Mock AI／Search |
| E2E | Playwright | 完整使用者流程 | Mock AI／Search |

### 測試環境的取得方式

- **PostgreSQL**：規格禁止在 Compose 重建 PostgreSQL，因此測試資料庫建在使用者既有實例上，名稱由 `DATABASE_URL` 推導為 `<db>_test`。以 `pnpm db:test:create` 建立（node-postgres 實作，**不需要 psql**）。
- **Redis**：使用同一個 Compose 容器，但切換到 `REDIS_TEST_DB`（index 1），與開發資料隔離。
- **不需要使用者提供任何額外環境變數** —— 符合規格「只手動提供三個變數」的要求。

### 為什麼 AI 與搜尋一律用 Mock

1. 真實模型輸出不決定性，測試會隨機失敗。
2. 實測單次呼叫延遲 4～8 秒，三階段流程會讓測試套件無法接受地慢。
3. 免費額度不該被 CI 消耗。
4. 需要能主動製造失敗（429、5xx、schema 不合法、注入內容）—— 真實 API 做不到。

真實 provider 另有少量「冒煙測試」，預設跳過，需明確設定 `RUN_LIVE_AI_TESTS=1` 才執行。

---

## 2. 單元測試

規格 §18 列出的 11 項全部涵蓋，每項含失敗案例。

### 2.1 JSON 匯入驗證

| 案例 | 期望 |
|---|---|
| 合法檔案 | 全部題目 status = `valid` |
| `schemaVersion` 為 `2.0.0` | `UNSUPPORTED_SCHEMA_VERSION`（error） |
| `type` 為 `fill_in_blank` | `INVALID_QUESTION_TYPE`（error） |
| 題幹為 `""` 或 `"   "` | `EMPTY_STEM`（error） |
| 只有 1 個選項 | `TOO_FEW_OPTIONS`（error） |
| 選項 key 為 `["A","A","B"]` | `DUPLICATE_OPTION_KEY`（error） |
| `correctAnswers: ["E"]` 但選項只到 D | `CORRECT_ANSWER_NOT_IN_OPTIONS`（error） |
| 單選題 `correctAnswers: ["A","B"]` | `SINGLE_CHOICE_MULTIPLE_ANSWERS`（error） |
| 複選題 `correctAnswers: ["A"]` | `MULTIPLE_CHOICE_TOO_FEW_ANSWERS`（error） |
| 批次內 `externalId` 重複 | `DUPLICATE_EXTERNAL_ID_IN_BATCH`（error） |
| 與既有題庫 `externalId` 衝突 | `DUPLICATE_EXTERNAL_ID_IN_DB`（error） |
| 同題組題號重複 | `DUPLICATE_QUESTION_NUMBER`（error） |
| `sourcePage: 0` 或 `-1` | `INVALID_SOURCE_PAGE`（error） |
| `explanation: null` | `MISSING_EXPLANATION`（**warning**，不阻擋 commit） |
| `reviewRequired: true` | `REVIEW_REQUIRED`（warning） |
| 選項 key 為小寫 `a` | `OPTION_KEY_NOT_UPPERCASE`（warning） |
| 題數超過上限 | `TOO_MANY_QUESTIONS`（error） |
| **`explanation` 缺失時不得被自動填入內容** | 驗證後 `explanation` 仍為 `null` |

### 2.2 單選題判分

| 案例 | 期望 |
|---|---|
| 選 A，答案 A | `isCorrect: true` |
| 選 B，答案 A | `isCorrect: false` |
| 未作答（空陣列） | `isCorrect: false` |
| 送出兩個答案給單選題 | 拒絕，`VALIDATION_FAILED` |
| 送出不存在的選項 key | 拒絕 |

### 2.3 複選題判分

| 案例 | 期望 |
|---|---|
| 選 `[A,C]`，答案 `[A,C]` | `true` |
| 選 `[C,A]`，答案 `[A,C]` | `true`（**順序無關**） |
| 選 `[A]`，答案 `[A,C]` | `false`（部分正確不給分） |
| 選 `[A,C,D]`，答案 `[A,C]` | `false`（多選不給分） |
| 選 `[]` | `false` |
| 含重複值 `[A,A,C]` | 去重後比對，`true` |

### 2.4 選項順序隨機後的答案映射

| 案例 | 期望 |
|---|---|
| `option_order = [C,A,D,B]`，正確答案 B | 顯示第 4 位為正確 |
| 使用者選顯示位置 4 → 送回 key `B` | `isCorrect: true` |
| 相同 `seed` 產生相同順序 | 可重現 |
| `shuffleOptions: false` | 順序等於原始 `sort_order` |
| **打亂後判分結果與未打亂完全一致** | 對同一組答案，兩種模式 `isCorrect` 相同 |

### 2.5 錯題狀態更新

| 案例 | 期望 |
|---|---|
| 首次答錯 | 建立紀錄，`mistake_count=1`、`mastery_state='active'` |
| 再答錯 | `mistake_count=2`、`consecutive_correct=0` |
| 答對 1 次 | `consecutive_correct=1`、`improving`、**紀錄仍存在** |
| 答對 2 次 | `improving` |
| 答對 3 次 | `mastered` |
| `mastered` 後又答錯 | 退回 `active`、`consecutive_correct=0`、`mistake_count+1` |
| 答對後不得刪除紀錄 | 查詢仍找得到 |

### 2.6 標籤別名映射

| 案例 | 期望 |
|---|---|
| `"行政處分"` → canonical | 命中 |
| `" 行政處分 "`（前後空白） | 正規化後命中 |
| `"行政處分"` 全形／半形差異 | 正規化後命中 |
| 英文大小寫差異 | 正規化後命中 |
| 完全不存在的名稱 | 回傳 null，觸發 `tag_suggestions` |

### 2.7 標籤合併

| 案例 | 期望 |
|---|---|
| A 合併到 B | A 的題目關聯轉到 B |
| 合併後 A 狀態 | `merged`，`merged_into_id = B` |
| 題目同時有 A 與 B | 去重，不產生重複關聯 |
| 合併會導致主要知識點超過 1 個 | 保留原 primary，另一個降為 secondary |
| 合併到自己 | 拒絕，`TAG_MERGE_INVALID_TARGET` |
| 合併到已 merged 的標籤 | 拒絕 |

### 2.8 AI JSON Schema 驗證

| 案例 | 期望 |
|---|---|
| 合法研究計畫 | 通過 |
| `needsExternalSearch: true` + `MODEL_ONLY` | **語意驗證攔下**（實測真實發生過） |
| `WEB_RESEARCH` 但 `queries: []` | 攔下 |
| `MODEL_ONLY` 但有 queries | 攔下 |
| `queries` 超過 3 組 | 攔下 |
| 證據引用不存在的 sourceId | 剔除該筆並設 `requiresHumanReview` |
| 單選題 `recommendedAnswer: ["A","B"]` | 攔下 |
| `optionAnalysis` 漏掉某個選項 | 攔下 |
| `agreesWithStoredAnswer: false` 但 `conflictReason: null` | 攔下 |
| `errorTypeCode` 不在允許清單 | 攔下 |
| `primaryKnowledgeTag` 不存在 | 轉為 `tag_suggestions`，不寫入標籤 |
| `MODEL_ONLY` 卻有 citations | 攔下 |

### 2.9 Cache key

| 案例 | 期望 |
|---|---|
| 相同輸入 | 相同 key |
| 題幹變更 | `content_hash` 改變 → 新 key |
| 選項文字變更 | 新 key |
| 正確答案變更 | 新 key |
| 選項順序變更但內容相同 | **相同 key**（正規化後比對） |
| `promptVersion` 變更 | 新 key |
| `model` 變更 | 新 key |
| 使用者選了不同答案 | 個人化分析 key 不同，題目層 enrichment key 相同 |

### 2.10 NVIDIA rate limiter

| 案例 | 期望 |
|---|---|
| 限制內連續請求 | 全部放行 |
| 超過 `NVIDIA_MAX_RPM` | 後續請求被擋 |
| 時間視窗過後 | 重新放行 |
| 重試請求 | 可動用 `NVIDIA_RETRY_RESERVE_RPM` 額度 |
| 併發請求（模擬多 worker） | Lua 原子性保證總數不超限 |
| `NVIDIA_MAX_RPM + RESERVE > 40` | **啟動時 `validateEnv()` 直接拒絕** |

### 2.11 Answer conflict 規則

| 案例 | 期望 |
|---|---|
| AI 同意題庫答案 | 不建立衝突紀錄 |
| AI 不同意且高信心 | 建立 `pending` 衝突，題目轉 `disputed` |
| AI 不同意但低信心 | 建立衝突但標記低信心 |
| 同題已有 pending 衝突 | 不重複建立（唯一索引） |
| 衝突期間的作答 | `is_provisional = true` |
| 能力統計查詢 | **排除 provisional 紀錄** |
| 裁決為 `kept_original` | 題目回 `active`，provisional 解除 |
| 裁決為 `answer_updated` | 答案更新、版本+1、`content_hash` 改變、AI 快取失效 |
| **系統絕不自動修改答案** | 任何 AI 路徑都不得寫入 `question_options.is_correct` |

### 2.12 環境變數驗證（補充）

| 案例 | 期望 |
|---|---|
| 缺 `NVIDIA_API_KEY` | 啟動失敗，訊息含鍵名 |
| **錯誤訊息不得含變數值** | 斷言輸出中不出現該值 |
| `DATABASE_URL` 非 postgres 協定 | 拒絕 |
| 秘密長度不足 | 拒絕 |

---

## 3. 整合測試

| 案例 | 驗證重點 |
|---|---|
| 匯入批次確認後寫入正式題庫 | commit 前 `questions` 無資料；commit 後題目、選項、關聯正確 |
| **有 error 的批次不得 commit** | 回 `IMPORT_HAS_BLOCKING_ERRORS`，`questions` 表完全沒有新增 |
| 部分題目被排除後 commit | 只寫入未排除的題目 |
| 作答並建立錯題紀錄 | 答錯後 `mistake_records` 出現對應列 |
| 交卷模式不洩漏答案 | **逐欄位斷言**交卷前回應不含 `correctAnswers`／`isCorrect`／`explanation` |
| 即答模式回傳判分 | 作答後回應含正確答案 |
| 禁止改答案時的 PATCH | `409 QUIZ_ANSWER_CHANGE_NOT_ALLOWED` |
| BullMQ 任務建立、執行、重試 | 任務入列、狀態流轉、失敗重試、達上限後停止 |
| 相同 idempotency key | 只建立一個任務 |
| NVIDIA provider mock | 三階段流程完整跑完並保存結果 |
| Search provider mock | 來源寫入 `question_evidence_sources`，sourceId 連續 |
| AI 分析完成後保存結果 | `question_ai_enrichments` 有 `is_current` 唯一列 |
| 重複分析同一題 | 命中快取，`reused: true`，**未呼叫 provider** |
| 題目修改後再分析 | `content_hash` 變更 → 快取失效 → 重新呼叫 |
| 爭議答案不計入能力分析 | 統計端點結果排除 provisional |
| AI 回傳未知標籤 | 進 `tag_suggestions`，`knowledge_tags` 無新增 |
| AI 回傳不存在 sourceId | 引用被剔除，`requiresHumanReview = true` |
| 章節與科目不符的題組 | 資料庫外鍵拒絕，回 `CHAPTER_SUBJECT_MISMATCH` |
| 主要知識點設定兩個 | 資料庫部分唯一索引拒絕 |
| 健康檢查 | PostgreSQL 與 Redis 皆 up |

---

## 4. E2E 測試（Playwright）

規格 §18 列出的 11 個流程全部涵蓋：

| # | 流程 | 關鍵斷言 |
|---|---|---|
| 1 | 首次初始化 + 登入 | `/setup` 可建帳號；完成後再訪問被導開；登入後進入儀表板 |
| 2 | 建立科目與題組 | 階層正確顯示 |
| 3 | 匯入 JSON | 上傳後進入預覽頁 |
| 4 | 預覽並確認 | 錯誤題目標紅、`reviewRequired` 醒目標示、修正後可 commit |
| 5 | 開始作答 | 題目依設定的順序與選項順序呈現 |
| 6 | 即答模式 | 作答後立即顯示對錯與解析 |
| 7 | 交卷模式 | **作答過程中畫面無任何答案線索**；交卷後才顯示 |
| 8 | 查看錯題 | 答錯的題目出現在錯題本 |
| 9 | 啟動單題 AI 分析 | 顯示任務已建立 |
| 10 | 查看分析進度與結果 | 進度階段依序推進至 `COMPLETED`，結果含解析與引用 |
| 11 | 查看多題整合分析 | 顯示弱點知識點與複習建議 |

E2E 一律以 `AI_PROVIDER=mock`、`SEARCH_PROVIDER=mock` 執行。

---

## 5. 執行指令

```bash
# 全部檢查（每個 Phase 結束時必跑）
pnpm verify              # typecheck + lint + test + build

# 個別
pnpm typecheck
pnpm lint
pnpm test                # 單元 + 整合
pnpm build

# 測試資料庫（首次或需重置時）
node scripts/create-test-db.mjs
node scripts/create-test-db.mjs --drop

# API 端到端驗證（Phase 1 起；需先啟動後端與 Redis）
# 預設打 :4101 的測試後端，不會誤打 pnpm dev 的 :4000 而污染正式題庫。
pnpm test:api-e2e
BASE=http://localhost:4000/api/v1 pnpm test:api-e2e # 要改目標才需要設 BASE
```

### 端到端腳本必須可以連續跑兩次

跑完一次就通過，只證明它在乾淨資料庫上會過；**第二次連續執行也必須通過**，
否則這套腳本只是一次性的煙霧測試，日後重跑會出現一堆與程式無關的假失敗，
真正的迴歸反而會被淹沒在雜訊裡。

因此腳本裡任何「使用者範圍內唯一」的值都要帶上本次執行的戳記：
科目名稱、題組名稱、標籤名稱，以及 **`externalId`（全域唯一，最容易被忽略）**。
斷言也一律用「相對」而非「絕對」的量：

| 不要這樣寫 | 要這樣寫 |
|---|---|
| `pagination.total === 2` | 先用 `subjectId` 限定範圍再比數量 |
| `list[0].name === '民法'` | 比較兩者的相對順序（`indexOf(a) < indexOf(b)`） |
| `stats.answeredCount === 5` | 先取基準值，再比 `基準 + 1` |

新增測試段落若動到統計，記得把後面既有斷言的基準值一起重新取，
不然會把「自己插進來的副作用」誤判成程式壞掉。

完整流程（Phase 4 起後端必須以 Mock provider 啟動）：

```bash
pnpm redis:up
node scripts/create-test-db.mjs --drop
cd packages/db && DATABASE_URL=<測試連線字串> npx drizzle-kit migrate && cd ..

# 先重置資料庫，再啟動後端 —— 種子資料是啟動時寫入的，順序反了會缺種子
DATABASE_URL=<測試連線字串> PORT=4101 AI_PROVIDER=mock SEARCH_PROVIDER=mock \
  node apps/api/dist/main.js

BASE=http://localhost:4101/api/v1 pnpm test:api-e2e
```

> 端到端驗證建議打在**測試資料庫**上，而不是平常使用的資料庫 ——
> 這些腳本會實際建立科目、題目與作答紀錄。作法是把後端以測試連線字串另起一個 port：
>
> ```bash
> DATABASE_URL=<主連線字串把資料庫名稱換成 <db>_test> PORT=4101 node apps/api/dist/main.js
> ```

**規格 §20.18：不得假裝測試通過。** 每個 Phase 的實作報告必須附上實際執行的指令與輸出。

---

## 6. 覆蓋率目標

| 範圍 | 目標 | 理由 |
|---|---|---|
| 判分邏輯（`gradeAnswer`、選項映射） | **100%** | 錯了就是系統性錯誤，且是純函式無藉口 |
| 匯入驗證規則 | **100%** | 每條規則都有明確的錯誤碼，逐條可測 |
| 熟練狀態計算 | **100%** | 純函式 |
| AI schema 與語意驗證 | **100%** | 這是防止錯誤資料入庫的關卡 |
| Service 層 | ≥ 80% | |
| Controller 層 | ≥ 70% | 主要由整合測試覆蓋 |
| 前端元件 | 不設數字目標 | 以 E2E 覆蓋關鍵流程更有價值 |

---

## 7. Phase 0 的測試現況

Phase 0 只交付架構與契約，尚無業務邏輯，因此沒有業務測試。已完成的是**實際執行過的環境驗證**（非自動化測試）：

| 驗證項目 | 結果 |
|---|---|
| `pnpm install` | 通過 |
| `pnpm bootstrap:env` 重複執行 | 冪等；使用者三個金鑰未被更動；變數數維持 69 |
| `apps/web/.env.local` 內容 | 只有 2 個 `NEXT_PUBLIC_*` 變數 |
| `pnpm typecheck` | 通過（4 個 workspace） |
| `pnpm lint` | 通過（`--max-warnings=0`） |
| `pnpm build` | 通過（packages + api + web） |
| `docker compose up -d redis` | 容器 healthy |
| `GET /api/v1/health` | 200 |
| `GET /api/v1/health/deps` | 200，postgres up、redis up |
| 不存在的路由 | 404 且為統一錯誤格式，含 requestId |
| `GET /docs` | 200（Swagger UI） |
| 移除 `NVIDIA_API_KEY` 後啟動 | 明確錯誤訊息、**不含金鑰內容**、exit code 1 |

自動化測試自 Phase 1 起隨功能一併建立。

---

## 8. Phase 2 的測試現況

| 類別 | 內容 | 數量 |
|---|---|---|
| 單元 | 判分（§2.2、§2.3） | 15 |
| 單元 | 熟練狀態與錯題摺疊（§2.5） | 18 |
| 單元 | 隨機出題、選項洗牌與答案映射（§2.4） | 17 |
| API E2E | `tests/api-e2e/phase2.mjs` | 104 |

`tests/api-e2e/phase2.mjs` 針對規格 §22 之 5～10 的重點驗證：

- **答案洩漏**：對整份 JSON 回應做**遞迴掃描**，任何非 null 的 `correctAnswers` / `isCorrect` /
  `explanation` / `reveal` 都算失敗。逐欄位列舉會隨契約演進失效，掃描才擋得住日後新增的欄位。
- **選項隨機後的判分**：在打亂的場次中送出真實代號，仍必須判為正確。
- **修改答案不重複計入錯題**：同一題經歷「答錯 → 改為答對」後，`mistakeCount` 必須等於
  實際答錯的次數，`totalAttempts` 必須等於詳情頁列出的歷次作答筆數。
- **狀態機完整往返**：`active` → 連續答對 3 次 → `mastered` → 再答錯 → 退回 `active`，
  且累計錯誤次數只增不減、紀錄不刪除。

腳本連續執行兩次皆為 104 通過 0 失敗（不依賴資料庫初始狀態）。

---

## 9. Phase 3 的測試現況

| 類別 | 內容 | 數量 |
|---|---|---|
| 單元 | 標籤正規化與種子資料（§2.6） | 21 |
| API E2E | `tests/api-e2e/phase3.mjs` | 76 |

重點驗證：

- **正規化**：全形／半形、大小寫、空白差異會收斂；**錯字不會**（那是別名的工作）。
- **合併關聯轉移**（FR-TAG-10）：特別測「某題同時掛了來源與目標」——
  這個情境會撞主鍵與 primary 的部分唯一索引，是最容易寫錯的地方。
  斷言合併後該題只剩一列、角色為 `primary`、標籤總數正確減少。
- **AI 無法繞過審核**（§22 之 12）：提交建議後斷言該名稱**解析不到任何正式標籤**，
  核准之後才解析得到。這是行為層的證明，不是「有寫審核程式」的宣稱。
- **fallback 保護**：「無法判定」不可停用，錯誤類型不接受新增。
- **標籤不影響題目版本**：設定標籤後斷言 `currentVersion` 與 `contentHash` 都沒變。

腳本連續執行兩次皆為 76 通過 0 失敗。所有斷言都以「本次執行建立的資料」或「增量」為基準，
不使用全域絕對數字 —— 否則腳本會因為資料庫殘留而失敗，那是測試的問題不是系統的問題。

---

## 10. Phase 4 的測試現況

| 類別 | 內容 | 數量 |
|---|---|---|
| 單元 | AI 輸出語意驗證（§2.8） | 30 |
| 單元 | 快取鍵與 URL 正規化（§2.9） | 22 |
| 單元 | SSRF 防護 | 38 |
| API E2E | `tests/api-e2e/phase4.mjs` | 63 |

### 為什麼一定要用 Mock provider

端到端測試必須以 `AI_PROVIDER=mock SEARCH_PROVIDER=mock` 執行，理由有二：

1. **真實模型的輸出不可重現。** 同樣的輸入不保證得到同樣的結果，
   斷言「解析內容包含某段文字」的測試會時好時壞，那比沒有測試更糟。
2. **每跑一次就消耗一次免費額度。** 開發過程中會跑上百次。

Mock 是**正式的 provider 實作**，不是測試替身的臨時 hack：
它走的是與真實 provider 完全相同的 Gateway、四層驗證、標籤解析與保存路徑，
被替換掉的只有最外層那一次 HTTP 呼叫。因此端到端測試涵蓋的是真正的業務流程。

Mock 刻意內建兩個「會出事」的情境，讓防護機制每次都被實際走過：

- 搜尋結果中固定含一筆 `169.254.169.254`（雲端 metadata 位址）——
  測試斷言它**不會**出現在證據集合中。
- 題幹含 `【衝突測試】` 時回報「題庫答案有誤」——
  走完整的爭議建立、題目轉 `disputed`、作答標 `is_provisional`、人工裁決流程。

### 重點驗證

- **一次分析剛好 3 次模型呼叫**：多了代表流程有誤，少了代表某一階段沒跑。
- **重複分析完全不呼叫模型**：以用量計數的差值斷言，不是看回應內容。
- **引用都指向實際存在的 sourceId**：對照證據集合逐筆比對。
- **AI 建議的標籤審核前解析不到正式標籤**：以行為證明驗收 #12。
- **爭議題的作答不計入統計、不進錯題本**：以 `/stats/overview` 的差值斷言；
  裁決後再斷言原本的作答重新計入。
- **AI 沒有改動題庫答案**：爭議建立後直接讀題目選項，確認 `isCorrect` 沒變。

腳本連續執行兩次皆為 63 通過 0 失敗。

> **重置測試資料庫之後必須重新啟動後端**：能力類型、錯誤類型與 prompt 版本
> 都是啟動時寫入的種子資料，先重置再跑測試會因為缺少種子而失敗。

---

## 11. Phase 5 的測試現況

### 單元測試（無資料庫）

| 檔案 | 重點 |
|---|---|
| `analysis/percent.spec.ts` | 分母為 0 回 `null` 而非 `0` —— 「沒作答」與「全部答錯」不能是同一個數字 |
| `analysis/trend.spec.ts` | 門檻邊界（剛好 ±10 個百分點）；**`trend === null` 與 `trend === 0` 分開斷言** |
| `analysis/streaks.spec.ts` | 連續錯誤只數到最近一次答對為止；多知識點交錯時互不污染 |
| `analysis/representative.spec.ts` | **打亂輸入順序後結果完全相同**；`accuracy: null` 貢獻 0 且不產生 `NaN` |
| `ai/schemas.spec.ts`（新增段落） | AI 自創知識點／錯誤類型／複習目標一律被擋下；rank 必須連續 |

其中最關鍵的一條是 representative 的**順序無關性**：排序若不是全序，
資料庫回傳順序的差異就會讓同一份統計挑出不同的題目，`stats_snapshot` 也就不再可重現。

### 端到端（`tests/api-e2e/phase5.mjs`，87 項）

這支腳本的重點不是「有沒有回 200」，而是**少掉任何一個過濾條件就會失敗**的斷言：

| 斷言 | 少了什麼就會失敗 |
|---|---|
| 一題掛 1 主 2 次知識點、作答一次 → 總數只加 1、出現在 3 個標籤桶、三個非標籤維度加總等於總數 | 若有人把 `overall` 改成由標籤查詢加總得出 |
| 爭議建立後：總數、科目桶、知識點桶**各自**減少相同筆數 | 任一支統計查詢漏掉 `is_provisional` 或題目狀態過濾 |
| 軟刪除後 `/stats/overview` 的錯題總數下降 | `overview()` 沒套用診斷判準（這正是 Phase 5 修掉的既有缺陷） |
| `/stats/overview.mistakeTotal === /mistakes/stats.total`，且在建立爭議與軟刪除後都成立 | 判準沒有共用，兩邊各寫一份 |
| 未交卷的 `after_submit` 場次：該題不出現在錯題本，**錯題總數也不變** | 只擋列表而沒擋計數——數字本身也會洩漏「你答錯了」 |
| 裁決後所有數字回到爭議前的基準值 | 把排除實作成破壞性刪除而非過濾 |
| 同樣期間呼叫兩次，`JSON.stringify` 逐位元組相同 | `ORDER BY` 掉了平手條件 |
| 多題分析的模型呼叫增量剛好 **1** | 流程多跑或少跑了階段 |
| 推薦的複習目標、最薄弱知識點名稱都能在統計快照中找到 | 參照完整性驗證失效，AI 可以憑空捏造 |

### 為什麼 `waitForJob` 等 90 秒而不是 30 秒

整套 E2E 一輪約 32 次模型呼叫，而全域限流是 30 RPM。連續跑第二輪時**必然**會有呼叫
被限流器擋下並等待下一個分鐘窗口——那是限流器正常運作。等太短會把「正在依規則等待」
誤判成失敗，實測就發生過一次（任務狀態停在 `active`，用量紀錄顯示 `rate_limited: 1`，
而該任務稍後確實完成）。

### 執行結果

| 情境 | 結果 |
|---|---|
| 全新資料庫跑完整套 | 43 + 52 + 104 + 76 + 74 + 87 = **436 項全過** |
| 緊接著再跑一次 | **432 項全過**（少的 4 項是只存在於全新資料庫的初始化區塊） |

---

## 12. 審計後的修正（Phase 5 之後）

進入 Phase 5 前的多代理審計提出 34 條候選問題。其中 12 條在 `2602e97` 與 Phase 5
已處理，之後又逐條驗證並修掉 13 條，其餘 9 條延後（理由見下）。

### 這一輪修掉的測試品質問題

| 問題 | 實際情況 |
|---|---|
| 驗收 #16 的引用完整性斷言是**空斷言** | 它檢查的是「沒有帶作答」那次分析的 `personalized.citations`，而該情況下 `personalized` 恆為 `null`、citations 恆為空陣列——空陣列的 `every()` 永遠回 true。改成在「帶作答」的路徑上驗，並先斷言引用確實存在 |
| `content_hash` 快取路徑沒被測到 | 原本的「重複分析不呼叫模型」測的是**冪等鍵相同 → 回到同一個任務**，沒有碰到快取本身。改用 q2 走「先帶作答分析、再不帶作答分析」：後者冪等鍵不同必為新任務，但內容沒變所以必須命中快取，斷言 `servedFromCache === true` 且模型呼叫數不變 |
| 進度回報沒有任何覆蓋 | `waitForJob` 改為記錄過程中觀察到的每個步驟，斷言全部都是合法值。**刻意不斷言「一定看得到某個中間步驟」**——Mock 很快，輪詢是否撞上某階段純看時序，那種斷言會變成隨機失敗 |
| `passWithNoTests` 讓 glob 失效也會全綠 | Phase 0 沒有測試時它是必要的；現在有 327 個測試，留著只會讓「一個測試都沒跑」被回報成成功。已從 `vitest.config.ts` 與 `test` 腳本移除 |

### 限流與 E2E 執行時間

整套 E2E 一輪的模型呼叫數已超過全域限流的 30 RPM，因此**連續跑第二輪時必然**
會有呼叫被限流器擋下、等待下一個分鐘窗口。phase4 與 phase5 的 `waitForJob`
因此都等 90 秒。實測確認過這是限流器正常運作：任務狀態停在 `active`、
用量紀錄出現 `rate_limited`，而該任務稍後確實完成。

### 執行結果

| 情境 | 結果 |
|---|---|
| 全新資料庫 | 43 + 52 + 104 + 76 + 87 + 87 = **449 項全過** |
| 緊接著再跑一次 | **445 項全過**（少的 4 項是只存在於全新資料庫的初始化區塊） |

---

## 13. 範圍限定與批次貼標籤（補完階段）

### 為什麼「範圍限定」需要一條「限定到不存在的 ID」的斷言

`scopeType`／`scopeRefIds` 原本被接受、驗證、存進資料庫，但**從未套用到任何一支統計查詢**。
那不是「功能沒做」，而是會存下一筆貼錯標籤的資料：要求「只分析行政法」，
拿到整個題庫的分析，卻被記錄成行政法的分析。

問題在於這種缺陷**看起來跟正常一模一樣**——數字都合理，只是範圍沒生效。
因此 E2E 除了「限定後總數變少」之外，還有一條決定性的斷言：

> 限定到一個**不存在**的科目 ID → `overall.totalAnswered` 必須是 0。

條件若被無聲忽略，這條會拿到完整的統計而失敗。這是唯一能區分
「範圍生效了」與「範圍被忽略但數字剛好看起來合理」的檢查。

另有一條防多對多放大：限定知識點時，`overall` 必須仍等於各科目桶的加總——
知識點是多對多，若用 join 而非 EXISTS，同一筆作答會被放大成多列。

### 批次貼標籤

| 斷言 | 少了什麼就會失敗 |
|---|---|
| 兩題都掛上主要與次要知識點 | 基本功能 |
| **批次貼知識點不會清掉既有的能力類型** | `QuestionTagsService.set()` 是整組取代，會連能力類型一起刪。批次路徑若直接傳空的能力類型進去，就會靜靜抹掉使用者標過的資料 |
| 主要與次要指同一標籤 → 400 | 契約層的 superRefine |
| 帶入不存在的知識點 → 404 | 證明批次路徑沒有繞過單題路徑的把關 |

### 執行結果

| 情境 | 結果 |
|---|---|
| 全新資料庫 | 43 + 52 + 104 + 76 + 87 + 103 = **465 項全過** |
| 緊接著再跑一次 | **461 項全過** |

---

## AI 輸出查核強化（引用原文、數字一致性、信心上限）

### 起因

一次真實的錯誤解析（投資學・第一章第 47 題，各類金融商品交易稅）。
答案 D 判定正確，但支撐它的數字有兩處錯誤，而**當時所有驗證全數通過**：

| 項目 | AI 寫的 | 正確 |
|---|---|---|
| 臺指期貨 | 契約金額 **0.02%**（10萬分之2） | 0.002%（差 10 倍） |
| 臺指選擇權 | **契約金額**千分之1 | **權利金**金額千分之1 |

逐字比對該次的三則 citation 後發現：

```
[S1] 逐字=false  ← 捏造
[S3] 逐字=true   ← 真實（也正好是唯一完全正確的那條事實）
[S4] 逐字=false  ← 捏造，內容就是那兩個錯誤數字
```

S4 是一份真實存在的財政部稅務手冊 PDF，通得過驗收 #16 的來源存在性檢查。
**問題不在指向假來源，而在指向真來源後編造它說過的話。**

### 三道新的查核

| 代號 | 規則 | 位置 |
|---|---|---|
| P1 | citation 的 `quote` 必須逐字出現在該來源正文中 | `refineCitationQuotes`（`ai/common.ts`） |
| P2 | 中文分數與緊鄰的百分比換算後必須一致 | `findNumericInconsistencies`（`ai/numeric-consistency.ts`） |
| P6 | 最終信心不得高於證據階段的信心 | `buildFinalExplanationSchema` |

三者都在**驗證層**，不增加任何模型呼叫。

設計取捨：

- P1 允許用「…」串接不連續片段（正當的引用寫法），但**每一段都要對得上**；
  比對前只去空白，不做標點或全半形轉換——寬鬆比對正是這個檢查要防的東西。
  失敗訊息明白告知 `quote` 可以填 `null`，讓重生有合法退路而不會必然耗盡次數。
- P2 只在兩個數字**緊鄰**（中間僅有括號、「即」這類同位語連接詞，且不超過 6 字）
  時才比較。距離一放寬，「股票千分之3、公司債千分之1，合計約0.4%」就會被誤判。
  容忍相對誤差 5%：要擋的是量級錯誤（10 倍以上），要放過的是四捨五入。
  **誤殺比漏抓更糟**——誤殺會讓合法解析反覆重生到整次分析失敗。
- P6 在**沒有任何來源時不套用**。證據階段在無來源時給的低信心講的是「沒有證據」，
  拿它當上限會把所有不需查證的題目一律壓到低分。

### 測試

單元測試 +29 項（`numeric-consistency.spec.ts` 15 項、`schemas.spec.ts` +14 項），
重點在**誤殺防線**與「省略號串接時只要有一段捏造就擋下」。

端到端在 `phase4.mjs` 新增 4 項。Mock provider 改為**逐字引用來源正文開頭**
（而不是靠繞過檢查讓測試變綠），另加 `【捏造引用測試】` 標記走反面路徑：

| 斷言 | 抓的是 |
|---|---|
| 引用的原文逐字出自該來源正文 | 正面路徑；少了它，下面三條可能只因「引用永遠被擋」而變綠 |
| **引用內容不在來源中時，分析失敗而不是照樣存起來** | P1 真的會擋 |
| 失敗原因指出是引用原文查核擋下的 | 擋下的理由正確，不是碰巧因別的原因失敗 |
| **被擋下的解析沒有落到資料庫** | 擋下後沒有部分寫入 |

驗證這條路徑走在正確的層：`ai_usage_logs` 出現 6 筆 `semantic_invalid`
（= 每次捏造任務 3 次呼叫〔初次 + 2 次重生〕× 2 輪 E2E），而非 `schema_invalid`。

### 執行結果

| 情境 | 結果 |
|---|---|
| 全新資料庫 | 43 + 52 + 110 + 76 + 96 + 103 = **480 項全過** |
| 緊接著再跑一次 | **476 項全過**（少的 4 項是只存在於全新資料庫的初始化區塊） |
| `pnpm verify` | exit 0，361 個單元測試 |

### 仍未處理（已知缺口）

同一次診斷還發現三個問題，都會改變證據蒐集行為，需另一輪處理：

| | 問題 | 影響 |
|---|---|---|
| P3 | 來源正文從**開頭**截斷（`EVIDENCE_SOURCE_MAX_CHARS=4000`） | 該次 S4 的期貨稅率表在 4000 字之後，模型手上根本沒有正確數字 |
| P4 | `preferredDomains` / `preferredSourceTypes` / `freshnessRequired` 產生後**無人消費** | plan 指定了 `law.moj.gov.tw`（有條文原文），但搜尋沒有用它 |
| P5 | 查詢數上限 3，比較型題目的選項可能覆蓋不全 | 該次 4 個選項只查了 3 個，漏掉的正是使用者選的那個 |
