# 實作計畫（IMPLEMENTATION_PLAN）

> 版本：0.1.0
> 階段劃分依規格 §19，不做變更。

---

## 每個 Phase 的完成定義（Definition of Done）

規格 §19 要求每階段都必須滿足，任一未達成即不算完成：

- [ ] 程式碼完成
- [ ] Migration 完成（**禁止在沒有 migration 的情況下改資料庫結構**，§20.20）
- [ ] 測試完成（單元／整合／E2E 依該階段範圍）
- [ ] 文件更新（本目錄下相關文件）
- [ ] `pnpm verify`（typecheck + lint + test + build）通過，**並附上實際輸出**（§20.18）
- [ ] 建立獨立 Git commit

**跨階段規則**：不得跨階段混亂修改（§20.12）。發現前一階段的缺陷時，修正它並記錄，不要順手把下一階段的功能一起做掉。

---

## Phase 0：架構與契約 ✅ 已完成

**目標**：把設計定下來，並讓開發環境能一鍵啟動。

### 交付內容

| 類別 | 項目 |
|---|---|
| 設計文件 | `SYSTEM_DESIGN`、`FUNCTIONAL_REQUIREMENTS`、`ARCHITECTURE`、`ERD`、`API_CONTRACT`、`SECURITY`、`TEST_PLAN`、`IMPLEMENTATION_PLAN` |
| 契約 | `QUESTION_IMPORT_SCHEMA.json`、`QUESTION_IMPORT_PROMPT.md`、`AI_ANALYSIS_SCHEMAS.md`、`AI_PROMPTS.md` |
| 骨架 | pnpm monorepo、`apps/api`（NestJS）、`apps/web`（Next.js）、`packages/contracts`、`packages/db` |
| 環境 | `.env.example`、`scripts/bootstrap-env.mjs`、`docker-compose.yml`（僅 Redis）、`scripts/create-test-db.mjs` |
| 已實作 | 環境變數 Zod 驗證、統一錯誤格式、request id、健康檢查、Swagger |

### Phase 0 刻意不做

業務邏輯、Drizzle table 定義、migration、AI 呼叫程式碼 —— 全部屬於後續階段。

---

## Phase 1：題庫核心

**目標**：能登入、能建立題庫階層、能匯入題目。
依使用者決定拆為 1a（認證與階層）與 1b（題目與匯入）兩段交付。

### Phase 1a ✅ 已完成

| 項目 | 內容 |
|---|---|
| 資料庫 | 13 張表全部建立並套用 migration（`0000_phase1_question_bank_core.sql`） |
| Auth | 首次初始化頁面（建立後永久 410）、登入、refresh token 輪替與重放偵測、CSRF double-submit、argon2id |
| 題庫階層 | 科目／章節／題組 CRUD、排序、軟刪除語意 |
| 前端 | `/setup`、`/login`、`/subjects`（含章節管理）、`/question-groups` |
| 測試 | 36 個單元測試 + 34 項 API 端到端驗證（`pnpm test:api-e2e`） |

實測確認的關鍵行為：

- 題組引用他科目章節 → 資料庫複合外鍵拒絕（PostgreSQL 23503），API 回 `409 CHAPTER_SUBJECT_MISMATCH`
- 題組 `chapterId = null` → 允許（章節可為空）
- 軟刪除後可重建同名科目（部分唯一索引生效）
- 刪除章節 → 題組退回直接隸屬科目，內容不消失
- 刪除科目／題組 → 連帶軟刪除，歷史資料保留
- 中文內容於 API ↔ PostgreSQL 之間往返正確
- 未登入 → 401；缺 CSRF 標頭 → 403；再次初始化 → 410

### Phase 1b ✅ 已完成

| 項目 | 內容 |
|---|---|
| 題目 | CRUD、篩選分頁（關鍵字／科目／章節／題組／題型／狀態／reviewRequired／有無解析）、批次移動與刪除與標記、版本快照、`content_hash` |
| 匯入 | 上傳 → 逐題驗證 → 暫存 → 預覽 → 修正／排除 → 重新驗證 → commit；另提供 `GET /imports/schema` 與 `GET /imports/prompt` |
| 前端 | `/questions`、`/questions/new`、`/questions/[id]/edit`、`/imports`、`/imports/[id]` |
| 測試 | 匯入驗證 44 個、content_hash 10 個單元測試；52 項 API 端到端驗證 |

實測確認的關鍵行為：

- **含錯誤的檔案上傳後，正式題庫題數完全沒有變化**；commit 回 `400 IMPORT_HAS_BLOCKING_ERRORS`
- 修正單題後自動重新驗證整批，錯誤數即時下降
- 排除錯誤題後即可 commit，且只寫入未被排除的題目
- 重複 commit 回 `409`
- 沒有解析的題目匯入後 `explanation` 仍為 `null`（系統不編造）
- `reviewRequired` 正確帶入並在預覽頁醒目標示
- 單選多答案／複選單答案／選項重複／選項不足／題號重複 皆被擋下
- 批次移動會同步維護反正規化的 `subjectId` / `chapterId`

### Phase 1b 原始工作項目

1. **資料庫**：`users`、`refresh_tokens`、`app_settings`、`subjects`、`chapters`、`question_groups`、`questions`、`question_options`、`question_versions`、`question_sources`、`import_batches`、`import_questions`、`import_validation_issues`
   - 含複合外鍵 `question_groups(subject_id, chapter_id) → chapters(subject_id, id)`
   - 含所有部分唯一索引
2. **Auth**：首次初始化頁面、登入、token 輪替、CSRF、argon2id
3. **題庫階層**：科目／章節／題組 CRUD + 排序
4. **題目**：CRUD、搜尋篩選分頁、批次操作、版本快照、`content_hash` 計算
5. **匯入**：上傳 → 驗證 → 暫存 → 預覽 → 修正／排除 → commit
6. **前端**：`/setup`、`/login`、`/subjects`、`/question-groups`、`/questions`、`/imports`
7. **共用**：`packages/contracts` 加入 API DTO 與匯入 schema 的 Zod 實作
8. **技術債處理**：引入 `nestjs-zod`（`ZodValidationPipe` + `patchNestJsSwagger`），讓同一份 Zod schema 同時做驗證與 OpenAPI 產生

### 測試

- 單元：匯入驗證全部 17 條規則（含 warning 與 error 的區別）
- 整合：commit 前後的資料庫狀態、有 error 時不得寫入、章節科目不符被外鍵擋下
- E2E：初始化 → 登入 → 建科目題組 → 匯入 → 預覽修正 → 確認

### 驗收對照
規格 §22 之 1、2、3、4

---

## Phase 2：作答與錯題 ✅ 已完成

**目標**：能作答、能判分、答錯進錯題本。

| 項目 | 內容 |
|---|---|
| 資料庫 | 5 張表（`quiz_sessions`、`quiz_session_scopes`、`quiz_session_questions`、`user_answers`、`mistake_records`）＋ `reveal_mode` enum，migration `0001_phase2_quiz_and_mistakes.sql` |
| 出題 | 科目／章節／題組範圍（聯集）、只作答錯題（交集）、順序／隨機、選項隨機、題數上限 |
| 判分 | `gradeAnswer()` 純函式；單選與複選（順序無關、部分正確與多選皆不給分） |
| 揭露 | 答案收斂在單一個可為 null 的 `reveal` 欄位；`after_submit` 交卷前連 `correctCount` 都是 null |
| 錯題 | 自動建立與更新、`computeMasteryState()`、篩選、詳情與歷次作答、重練 |
| 統計 | `GET /stats/overview`：作答數、正確率、平均作答時間、錯題分布、近期場次、各科目表現 |
| 前端 | `/dashboard`、`/quiz`、`/quiz/new`、`/quiz/[sessionId]`、`/quiz/[sessionId]/result`、`/mistakes`、`/mistakes/[questionId]` |
| 測試 | 50 個單元測試（判分 15、熟練狀態 18、隨機與答案映射 17）＋ 104 項 API 端到端驗證 |

實測確認的關鍵行為：

- `after_submit` 模式交卷前，**對整份回應做遞迴掃描**（不是逐欄位列舉）找不到任何答案類欄位
- 交卷前索取結果 → `409 QUIZ_ANSWER_NOT_REVEALED_YET`；交卷後同一支端點才回傳答案
- 選項隨機化後，選中真實代號仍判為正確；打亂的是顯示順序，判分永遠比對 `correct_answers_snapshot`
- 複選題順序相反判為答對；部分正確與多選皆不給分
- 修改答案不新增作答列，因此**不會被重複計入錯題次數**，場次已作答數也不會虛增
- 連續答對 3 次 → `mastered`；再答錯一次 → 退回 `active` 且累計錯誤次數 +1，**紀錄不刪除**
- 第一次就答對的題目不會進錯題本；`totalAttempts` 與詳情頁列出的歷次作答筆數一致
- 空題組出題 → `422 QUIZ_NO_QUESTIONS_MATCHED`；不存在的科目 → `404 SUBJECT_NOT_FOUND`
- 未作答題目在結果頁 `isCorrect` 為 `null`（與答錯區分），但計分時視同答錯

### 與原規劃的差異

| 項目 | 原規劃 | 實際 | 理由 |
|---|---|---|---|
| 資料表數 | 6 張 | **5 張** | `mistake_record_error_types` 與 `mistake_records.last_error_type_id` 需外鍵指向 Phase 3 的 `error_types`，一併延後；不建立沒有外鍵的孤兒欄位 |
| 錯題更新方式 | 未指定 | **由作答歷史重算** | 使用者可修改答案，增量累加需要不唯一的反向運算；重算是冪等的 |
| `POST /answers` 回應 | 兩種不同形狀 | **統一含 `reveal`** | 答案只有一個出口，測試可用單一斷言鎖住 |
| `knowledgeTagIds` | 列於請求 | **移除，Phase 3 再加** | FR-QUIZ-06 本就屬 P3；不宣稱支援尚未實作的功能 |

### 驗收對照
規格 §22 之 5、6、7、8、9、10 —— 全數達成。

---

## Phase 3：標籤系統 ✅ 已完成

**目標**：建立受控詞彙，為 AI 分析準備好可選標籤。

| 項目 | 內容 |
|---|---|
| 資料庫 | 8 張表（`knowledge_tags`、`skill_tags`、`error_types`、`question_knowledge_tags`、`question_skill_tags`、`tag_aliases`、`tag_suggestions`、`mistake_record_error_types`）＋ `mistake_records.last_error_type_id`，migration `0002_phase3_controlled_tags.sql` |
| 種子資料 | 6 種能力類型、8 種錯誤類型（含 fallback「無法判定」），**啟動時自動寫入且只新增不覆寫** |
| 正規化 | `normalizeTagName()`：NFKC（全形轉半形）→ 轉小寫 → 去掉所有空白 |
| 管理 | 新增、改名、停用／啟用、刪除（僅限未使用）、合併（含關聯轉移與自動建立別名） |
| 審核 | `tag_suggestions` 的 approve／merge／reject，含重複建議累加次數 |
| 題目關聯 | `PUT /questions/:id/tags`，主要 1 個 + 次要 2 個，三層把關 |
| 作答 | FR-QUIZ-06「只作答特定知識點」；錯題本可依知識點與錯誤類型篩選 |
| 前端 | `/tags`（知識點／能力類型／錯誤類型／別名四個分頁）、`/tags/suggestions`、題目編輯頁的標籤區塊、出題與錯題本的篩選 |
| 測試 | 21 個單元測試（正規化與種子資料）＋ 76 項 API 端到端驗證 |

實測確認的關鍵行為：

- 「行政處分」「 行政 處分 」「ＲＯＥ 分析」與「roe分析」都會被正規化收斂，重複建立回 `409`
- 錯字（「行政處份」）**不會**被自動收斂 —— 那必須由別名明確登錄，正規化不猜測意圖
- **合併時關聯完整轉移**：某題同時掛了來源（主要）與目標（次要）時，合併後只剩一列且角色為主要
- 合併後來源標籤保留為 `merged` 並指向目標，來源名稱自動成為目標的別名
- 已被使用的標籤不可直接刪除（回 `409`，提示改用停用或合併）
- **審核前，建議的名稱完全解析不到正式標籤** —— AI 沒有任何繞過審核的路徑
- 錯誤類型不接受新增，fallback「無法判定」不可停用
- 設定標籤**不會**遞增題目版本，也不改變 `content_hash`

### 與原規劃的差異

| 項目 | 原規劃 | 實際 | 理由 |
|---|---|---|---|
| 標籤寫入位置 | 未指定 | **獨立的 `PUT /questions/:id/tags`** | 走題目更新端點會連帶寫版本快照並改動 `content_hash`，讓「這題被改過幾次」失去意義，也會誤使 Phase 4 的 AI 快取失效 |
| `usage_count` | ERD 列為欄位 | **即時計算，不存欄位** | 合併、刪除、改標籤都會影響它，任何一條路徑忘了維護就會靜默失準；與錯題紀錄採同一原則 |
| 錯誤類型新增 | 未限制 | **不提供新增／刪除端點** | 自由新增會讓錯因統計失去可比較性；要退場請用停用 |

### 原始工作項目

1. **資料庫**：`knowledge_tags`、`skill_tags`、`error_types`、`question_knowledge_tags`、`question_skill_tags`、`tag_aliases`、`tag_suggestions`，以及由 Phase 2 移入的 `mistake_record_error_types` 與 `mistake_records.last_error_type_id`（兩者都需要 `error_types` 才能建立外鍵）
2. **種子資料**：6 種能力類型、8 種錯誤類型（含 fallback「無法判定」）
3. **正規化**：別名比對（去空白、大小寫、全形半形）
4. **管理**：新增、改名、合併（含關聯轉移）、停用
5. **審核**：`tag_suggestions` 的 approve／merge／reject 流程
6. **題目關聯**：主要 1 個 + 次要 2 個的限制（DB 部分唯一索引 + service 檢查）
7. **前端**：`/tags`、`/tags/suggestions`；題目編輯頁加入標籤選擇
8. **作答**：補上「只作答特定知識點」（FR-QUIZ-06）

### 驗收對照
規格 §22 之 11、12 —— 全數達成（12 的 AI 端驗證在 Phase 4 接上真實分析後補完）。

---

## Phase 4：AI 與搜尋

**目標**：三階段單題分析可端到端運作。

**這是風險最高的階段**，建議依下列子步驟推進，每步都能獨立驗證：

### 4a. 基礎設施
- Redis 連線與 Lua 限流腳本
- BullMQ 三條佇列、job 狀態與進度寫入 PostgreSQL
- `ai_jobs`、`ai_usage_logs`、`prompt_versions` 資料表

### 4b. Provider 抽象
- `AiProvider` 介面、`MockAiProvider`（**先做 mock**）
- `AiGatewayService`：限流、重試、schema 驗證、用量記錄
- `NvidiaAiProvider`：實測已確認的參數（`json_schema` strict、`reasoning_effort`、`usage`、錯誤格式）

> 先做 Mock 再做真實 provider，可以在不消耗額度的情況下把整條流程跑通。

### 4c. 搜尋層
- `SearchProvider` 介面、`MockSearchProvider`、`TavilySearchProvider`
- URL 去重、trust tier 排序、正文截斷、sourceId 指派
- Redis 快取 + `web_documents` 跨題重用
- SSRF 防護（若需直接抓取）

### 4d. 三階段流程
- Prompt 檔案與 `prompt_versions` seed
- Zod schema + superRefine 語意驗證（`packages/contracts/src/ai/`）
- 五步 job：researchPlan → webSearch → evidenceSynthesis → finalExplanation → saveResult
- 引用驗證：`citations ⊆ sourceIds`
- 標籤處理：對不上既有標籤 → `tag_suggestions`

### 4e. 答案衝突
- `answer_conflicts` 建立、題目轉 `disputed`、作答標 `is_provisional`
- 統計查詢一律排除 provisional
- 人工裁決五種決策

### 4f. 前端
- `/analysis/questions/[questionId]`（含進度輪詢）
- `/conflicts`、`/ai/jobs`

### 測試

- 單元：AI schema 驗證全部案例（含實測踩過的語意矛盾）、cache key、限流器
- 整合：三階段完整流程（mock）、重複分析命中快取、題目變更後快取失效、未知 sourceId 被剔除、未知標籤進建議、爭議題不計入統計
- E2E：啟動分析 → 觀察進度 → 查看結果與引用

### 驗收對照
規格 §22 之 12、13、14、15、16、17、18

---

## Phase 5：多題分析與管理功能

**目標**：從單題解析升級到整體學習診斷。

### 工作項目

1. **統計彙總**：PostgreSQL 查詢實作全部 §11 要求的統計項目（一律排除 provisional）
2. **代表錯題挑選**：依統計權重挑出最多 15 題摘要
3. **多題分析**：`aggregate_analysis` prompt、schema、job、`aggregate_analyses` 表
4. **AI 任務管理**：任務列表、取消、失敗重跑
5. **Prompt 版本管理**：版本清單與啟用狀態
6. **AI 用量頁面**：呼叫次數、token 用量、延遲分布、失敗率
7. **維護佇列**：過期證據清理、統計重算、`web_documents` 清理
8. **前端**：`/analysis/aggregate`、`/ai/jobs`、`/ai/usage`、`/settings` 完整化

### 測試

- 整合：統計正確性（含 provisional 排除）、代表錯題挑選邏輯、分析結果保存 snapshot
- E2E：查看多題整合分析

### 驗收對照
規格 §22 之 19、21

---

## 里程碑總覽

| Phase | 主題 | 新增資料表 | 主要風險 |
|---|---|---|---|
| 0 ✅ | 架構與契約 | 0 | — |
| 1 ✅ | 題庫核心 | 13 | 匯入驗證規則繁多，需逐條測試 |
| 2 ✅ | 作答與錯題 | 5 | 答案洩漏；選項映射錯誤 |
| 3 ✅ | 標籤系統 | 8（含由 Phase 2 移入的 `mistake_record_error_types`） | 合併時的關聯轉移與 primary 衝突 |
| 4 | AI 與搜尋 | 8 | **最高**：外部相依、延遲、額度、輸出品質 |
| 5 | 多題分析與管理 | 2 | 統計查詢效能與正確性 |

---

## 跨階段的持續規範

| 規範 | 出處 |
|---|---|
| 不得刪除既有功能或資料，除非有明確理由並先記錄 | §20.19 |
| 不得在沒有 migration 的情況下修改資料庫結構 | §20.20 |
| 不得假裝測試通過，必須提供實際指令與結果 | §20.18 |
| 發現規格衝突時，優先選擇資料正確性、可追蹤性與簡單可維護方案 | §20.14 |
| 不為單一使用者過度設計微服務 | §20.15、§20.16 |
