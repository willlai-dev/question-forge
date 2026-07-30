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
pnpm db:test:create
pnpm db:test:create -- --drop

# E2E（Phase 1 起）
pnpm test:e2e
```

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
