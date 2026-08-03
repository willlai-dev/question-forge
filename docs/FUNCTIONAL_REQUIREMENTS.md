# 功能規格（FUNCTIONAL_REQUIREMENTS）

> 版本：0.1.0（Phase 0）

編號規則：`FR-<模組>-<序號>`。每條標註實作階段（P1～P5）。

---

## 1. 認證與初始化（Auth）

| 編號 | 需求 | 階段 |
|---|---|---|
| FR-AUTH-01 | 系統首次啟動且 `users` 表為空時，前端 `/setup` 可建立唯一帳號（帳號、密碼、密碼確認）。 | P1 |
| FR-AUTH-02 | 帳號建立完成後，初始化端點永久停用，再次呼叫回 `410 SETUP_ALREADY_COMPLETED`。停用狀態記錄於 `app_settings`。 | P1 |
| FR-AUTH-03 | 密碼以 argon2id 雜湊儲存，明文不得出現在資料庫、log 或任何 API 回應。 | P1 |
| FR-AUTH-04 | 登入成功後發出 access token（短效）與 refresh token（長效），皆存於 HttpOnly Cookie。 | P1 |
| FR-AUTH-05 | Refresh token 採輪替（rotation）；資料庫只存雜湊值；使用過的舊 token 立即失效。 | P1 |
| FR-AUTH-06 | 所有狀態變更請求需通過 CSRF 檢查（double-submit token + Origin 檢查）。 | P1 |
| FR-AUTH-07 | 登出清除 Cookie 並撤銷該 refresh token。 | P1 |
| FR-AUTH-08 | 密碼最短 8 字元，且不得與帳號相同。 | P1 |

## 2. 題庫階層（科目／章節／題組）

| 編號 | 需求 | 階段 |
|---|---|---|
| FR-CAT-01 | 科目可新增、修改、刪除、排序。 | P1 |
| FR-CAT-02 | 章節隸屬科目，可新增、修改、刪除、排序。 | P1 |
| FR-CAT-03 | 題組隸屬科目；章節為選填，允許題組直接掛在科目下。 | P1 |
| FR-CAT-04 | 題組可設定名稱、描述、來源、年份、備註。 | P1 |
| FR-CAT-05 | 題組的章節必須屬於同一科目，由資料庫複合外鍵保證，而非只靠應用層檢查。 | P1 |
| FR-CAT-06 | 刪除採軟刪除（`deleted_at`）；已被作答紀錄引用的資料永不硬刪。 | P1 |
| FR-CAT-07 | 排序以 `sort_order` 整數欄位維護，提供批次重排端點。 | P1 |

## 3. 題目管理

| 編號 | 需求 | 階段 |
|---|---|---|
| FR-Q-01 | 支援題型：`single_choice`（單選）、`multiple_choice`（複選）。 | P1 |
| FR-Q-02 | 題目至少 2 個選項；選項 key 在同一題內唯一。 | P1 |
| FR-Q-03 | 單選題正確答案恰為 1 個；複選題正確答案至少 2 個。 | P1 |
| FR-Q-04 | 題目可跨題組移動。 | P1 |
| FR-Q-05 | 題目列表支援關鍵字、科目、章節、題組、題型、標籤、`reviewRequired`、狀態篩選與分頁。 | P1 |
| FR-Q-06 ✅ | 支援批次操作：移動題組、批次刪除、批次貼標籤、批次設定 `reviewRequired`。批次貼標籤是**取代**語意，且逐題走 QuestionTagsService，不繞過單題路徑的規則；能力類型會原樣保留。 | P1／P5 |
| FR-Q-07 | 題目內容變更時寫入 `question_versions` 快照，並更新 `content_hash`。 | P1 |
| FR-Q-08 | `explanation` 允許為空；系統絕不自動編造解析。 | P1 |
| FR-Q-09 ⚠️ | 題目可記錄來源。**部分達成**：實際用 `questions.source_page` 與 `source_reference`，可記 PDF 頁碼與書目文字；URL 與多來源未實作，`question_sources` 表目前無人讀寫（見 ERD 說明）。 | P1 |

## 4. JSON 匯入

| 編號 | 需求 | 階段 |
|---|---|---|
| FR-IMP-01 | 使用者上傳 JSON 檔（大小上限 `IMPORT_MAX_FILE_SIZE_BYTES`，題數上限 `IMPORT_MAX_QUESTIONS`）。 | P1 |
| FR-IMP-02 | 系統以 JSON Schema 驗證，建立匯入批次，資料先進暫存區（`import_questions`）。 | P1 |
| FR-IMP-03 | **未驗證資料絕不寫入正式 `questions` 表。** | P1 |
| FR-IMP-04 | 顯示匯入預覽，逐題列出錯誤（error）與警告（warning）。 | P1 |
| FR-IMP-05 | 使用者可在預覽中修正、排除或確認個別題目，並可重新驗證。 | P1 |
| FR-IMP-06 | 只有在沒有阻斷性錯誤時才允許 commit；commit 後才寫入正式題庫。 | P1 |
| FR-IMP-07 | `reviewRequired` 的題目在預覽介面必須醒目標示。 | P1 |
| FR-IMP-08 | 系統提供固定的 PDF 整理 Prompt 供使用者複製（`GET /imports/prompt`）。 | P1 |
| FR-IMP-09 | 匯入批次保留原始上傳內容，可追溯。 | P1 |

驗證規則與錯誤碼完整清單見 [API_CONTRACT.md](./API_CONTRACT.md)。

## 5. 作答系統

| 編號 | 需求 | 階段 |
|---|---|---|
| FR-QUIZ-01 | 可從科目、章節或題組開始作答。 | P2 |
| FR-QUIZ-02 | 出題順序支援：順序、隨機。 | P2 |
| FR-QUIZ-03 | 支援選項順序隨機。 | P2 |
| FR-QUIZ-04 | 可指定題數上限。 | P2 |
| FR-QUIZ-05 | 可只作答錯題。 | P2 |
| FR-QUIZ-06 ✅ | 可只作答特定知識點。 | P3 |
| FR-QUIZ-07 | 答案揭露模式：`immediate`（即答）／`after_submit`（交卷後）。 | P2 |
| FR-QUIZ-08 | 可設定允許或禁止修改答案；禁止時修改請求回 `409`。 | P2 |
| FR-QUIZ-09 | 顯示作答進度、正確率、答題時間。 | P2 |
| FR-QUIZ-10 | **判分完全由程式執行，不使用 AI。** | P2 |
| FR-QUIZ-11 | `after_submit` 模式在交卷前，API 回應中不得包含任何正確答案資訊。 | P2 |
| FR-QUIZ-12 | 作答紀錄保存：`quizSessionId`、`questionId`、`selectedAnswers`、`correctAnswersSnapshot`、`isCorrect`、`responseTimeMs`、`attemptNumber`、`answeredAt`、`answerChangedCount`、`revealMode`。 | P2 |
| FR-QUIZ-13 | 題目日後被修改時，歷史紀錄仍保有當時的答案快照與題目版本號。 | P2 |
| FR-QUIZ-14 ✅ | 爭議題（`answer_conflicts` 待審）的作答標記 `is_provisional`，不計入正式能力診斷。**建立爭議時會回頭把該題既有作答一併補標**——真實流程是「先答錯 → 進錯題本 → 才按 AI 分析」，觸發分析的那一筆必然早於 disputed 狀態。錯題本／錯題統計另在讀取端排除 `disputed`／`excluded` 題目。 | P4 |

## 6. 錯題系統

| 編號 | 需求 | 階段 |
|---|---|---|
| FR-MIS-01 | 答錯的題目自動建立或更新 `mistake_records`。 | P2 |
| FR-MIS-02 | 錯題本支援依科目、章節、題組、知識點、錯誤類型篩選。 | P2／P3 |
| FR-MIS-03 | 顯示錯誤次數、最近答錯時間、是否已重新答對、連續答對次數。 | P2 |
| FR-MIS-04 | 可直接從錯題本建立重新練習的作答場次。 | P2 |
| FR-MIS-05 | **答對一次不刪除錯題紀錄。** | P2 |
| FR-MIS-06 | 熟練狀態：`active`（連續答對 0 次）／`improving`（1～2 次）／`mastered`（≥3 次）；任何一次答錯即重置為 `active`。 | P2 |
| FR-MIS-07 | 熟練狀態由純函式 `computeMasteryState()` 計算，規則可解釋且可單元測試。 | P2 |
| FR-MIS-08 | 可查看單題 AI 分析與多題整合分析入口。 | P4／P5 |

## 7. 受控標籤系統

| 編號 | 需求 | 階段 |
|---|---|---|
| FR-TAG-01 | 三類受控詞彙：知識點（`knowledge_tags`）、能力類型（`skill_tags`）、錯誤類型（`error_types`）。 | P3 |
| FR-TAG-02 | 每題主要知識點最多 1 個（資料庫部分唯一索引保證），次要知識點最多 2 個。 | P3 |
| FR-TAG-03 | 每題主要能力類型最多 1 個。 | P3 |
| FR-TAG-04 | 能力類型預設值：概念辨識、條件判斷、規則適用、案例推理、例外規則辨識、資料判讀。 | P3 |
| FR-TAG-05 | 錯誤類型預設值：概念混淆、忽略題目條件、例外規則遺漏、規則適用錯誤、選項比較錯誤、記憶錯誤、推理中斷、無法判定。 | P3 |
| FR-TAG-06 | **AI 只能從既有標籤中選擇**；找不到適合者只能提交 `suggestedNewTag`。 | P3／P4 |
| FR-TAG-07 | 新標籤流程狀態：`pending` → `approved` / `merged` / `rejected`，需管理者審核。 | P3 |
| FR-TAG-08 | 支援標籤新增、改名、合併、停用。 | P3 |
| FR-TAG-09 | 支援別名（`tag_aliases`），將相似名稱正規化映射到 canonical tag。 | P3 |
| FR-TAG-10 | 合併標籤時，既有題目關聯一併轉移，不得遺失資料。 | P3 |

## 8. AI 分析

### 8.1 單題三階段分析

| 編號 | 需求 | 階段 |
|---|---|---|
| FR-AI-01 | 流程固定為：程式判分 → AI 研究規劃 → 程式搜尋擷取 → AI 證據整理 → AI 最終解析 → 保存結果。 | P4 |
| FR-AI-02 | 每題最多 3 次模型請求，每次職責明確。 | P4 |
| FR-AI-03 | 三次呼叫的輸出皆為固定 JSON，欄位定義見 [AI_ANALYSIS_SCHEMAS.md](./AI_ANALYSIS_SCHEMAS.md)。 | P4 |
| FR-AI-04 | `researchMode` 僅允許 `MODEL_ONLY`、`PDF_KNOWLEDGE`、`WEB_RESEARCH`、`HYBRID`。 | P4 |
| FR-AI-05 | 每題搜尋關鍵字最多 3 組。 | P4 |
| FR-AI-06 | 搜尋與擷取由程式執行：URL 去重、來源可信度排序、正文清洗、長度上限、快取。 | P4 |
| FR-AI-07 | **AI 引用只能指向本次證據集合中實際存在的 sourceId**；不符者剔除並標記需人工複核。 | P4 |
| FR-AI-08 | 最終解析至少包含：正確答案、核心概念、解題步驟、每個選項對錯原因、使用者可能選錯的原因、忽略的條件、錯誤類型、主要知識點、複習建議、支持結論的來源。 | P4 |
| FR-AI-09 | 每次模型呼叫寫入 `ai_usage_logs`（含 operation、model、promptVersion、status、latency、token 數、reasoning effort、error code、retry count）。 | P4 |
| FR-AI-10 | 分析結果永久保存於 PostgreSQL，符合條件時重複使用不重跑。 | P4 |

### 8.2 答案衝突

| 編號 | 需求 | 階段 |
|---|---|---|
| FR-CONF-01 | AI 與外部證據認為題庫答案可能錯誤時，建立 `answer_conflicts` 紀錄，**不得自動修改答案**。 | P4 |
| FR-CONF-02 | 紀錄內容：`storedAnswer`、`verifiedAnswer`、`confidence`、`evidence`、`conflictReason`、`requiresReview`、`reviewStatus`。 | P4 |
| FR-CONF-03 | 前端在該題顯示「答案存在爭議」。 | P4 |
| FR-CONF-04 | 待審期間該題不用於能力診斷，作答結果標示為暫定。 | P4 |
| FR-CONF-05 | 人工可裁決為：保留原答案／修改答案／更新解析／標記為爭議題／排除該題。 | P4 |
| FR-CONF-06 ✅ | 裁決為「修改答案」時，該題**所有既有作答必須以新答案重新判分**（沿用與作答當下同一支純函式 `gradeAnswer`，不經 AI），再恢復計入統計；否則等於用新答案的名義把舊答案的判定結果放回診斷。 | P4 |
| FR-CONF-07 ✅ | 裁決為「標記為爭議題」或「排除該題」時，作答**維持**暫記不計入診斷；其餘裁決才恢復。任何裁決後一律重算錯題紀錄。 | P4 |

### 8.3 多題整合分析

| 編號 | 需求 | 階段 |
|---|---|---|
| FR-AGG-01 ✅ | **先由 PostgreSQL 完成統計彙總**，不把所有完整題目一次送給模型。分析範圍（`scopeType`／`scopeRefIds`）確實套用到每一支統計查詢；知識點維度用 EXISTS 而非 join，避免多對多把作答數放大。 | P5 |
| FR-AGG-02 ✅ | 統計項目：各科目／章節／題組／知識點正確率、各錯誤類型次數、平均作答時間、連續答錯次數、重複錯誤概念、近期正確率變化、已改善與未改善項目。 | P5 |
| FR-AGG-03 ✅ | 依統計挑選代表錯題後才交給 AI。 | P5 |
| FR-AGG-04 ✅ | 輸出：最薄弱知識點、最常見錯誤類型、關聯錯誤模式、優先複習順序、推薦重練題組／題目、是否有改善、具體學習建議、分析依據與 confidence。 | P5 |
| FR-AGG-05 ✅ | 保存版本、模型、Prompt 版本與統計 snapshot。**snapshot 為 NOT NULL**——可為 null 等於允許存在一列無法回頭驗證的結論。 | P5 |
| FR-AGG-06 ✅ | 統計一律套用共用的診斷判準（`apps/api/src/common/diagnostic-scope.ts`）：排除暫記作答、軟刪除題目、爭議中與已排除題目。判準只有一份，儀表板、錯題頁與多題分析共用。 | P5 |
| FR-AGG-07 ✅ | 代表錯題挑選為**決定性純函式**（`packages/contracts/src/analysis/representative.ts`，零 import）：同一份統計永遠挑出同一組題目與同樣的排列，否則 snapshot 不可重現。排序以 questionId 字典序收尾以構成全序。 | P5 |
| FR-AGG-08 ✅ | 「一題掛多個知識點」造成的扇出只存在於知識點統計內；總數與科目／章節／題組維度由**不 join 標籤表**的獨立查詢計算，並回報 `knowledgeTagCoverage` 讓扇出程度可見。 | P5 |
| FR-AGG-09 ✅ | 趨勢定義：期間自中點切半比較，前後半段各至少 5 筆、差異達 10 個百分點才判定進步／退步；資料不足時 trend 為 **null 而非 0**。 | P5 |

## 9. 背景工作與進度

| 編號 | 需求 | 階段 |
|---|---|---|
| FR-JOB-01 ⚠️ | 佇列：**實際只有一條** `ai-question-analysis`，兩種 AI 任務依 payload 的 `kind` 分派；維護作業改為手動觸發端點而非佇列。刻意偏離：單一使用者、限流本來就是全域的，第二條佇列只會多一組 Redis 連線而換不到任何東西。 | P4 |
| FR-JOB-02 | Job 狀態：`pending`、`active`、`completed`、`failed`、`retrying`、`cancelled`。 | P4 |
| FR-JOB-03 | 進度階段：`ANALYZING_QUESTION`、`SEARCHING_SOURCES`、`SYNTHESIZING_EVIDENCE`、`GENERATING_EXPLANATION`、`SAVING_RESULT`、`COMPLETED`，並寫入 PostgreSQL 以確保可靠。 | P4 |
| FR-JOB-04 | 前端以 1～2 秒輪詢取得進度；第一版不使用 WebSocket。 | P4 |
| FR-JOB-05 | 相同 job 具備 idempotency（`idempotency_key` 唯一 + BullMQ jobId 去重）。 | P4 |
| FR-JOB-06 ⚠️ | 任務優先級：① 單題分析 ② 多題分析 ④ 維護工作皆可指定 priority。**③ 匯入後背景分析未實作**——匯入模組不觸發任何 AI 任務。刻意未做：一次匯入 200 題會自動產生 600 次模型呼叫，在 30 RPM 的免費額度下等於綁架整條佇列二十分鐘，應該由使用者自己決定何時分析。 | P4 |
| FR-JOB-07 ✅ | 失敗任務可在管理頁重跑；不得無限重試。多題分析沒有 questionId，範圍存於 `ai_jobs.target_ref`，重跑時據此還原。 | P5 |

## 9.1 系統設定與維護

> 規格 §16 只寫了一行「系統設定頁」，沒有定義內容。以下是 Phase 5 據此收斂出的範圍，
> 原則是**只放改動不會破壞既有資料的項目**。

| 編號 | 需求 | 階段 |
|---|---|---|
| FR-SET-01 ✅ | 可設定作答預設值：模式、出題順序、每次題數、對答案時機、是否打亂選項、是否允許改答案。存於 `app_settings` 的 `quiz.defaults`。 | P5 |
| FR-SET-02 ✅ | 部分更新也必須用完整 schema 重新驗證合併後的結果，避免拼出不合法的組合。 | P5 |
| FR-SET-03 ✅ | 顯示唯讀系統資訊：provider、模型、各階段 reasoning effort、證據保留天數。 | P5 |
| FR-SET-04 ✅ | **機密變數只回報「有沒有設定」的布林值，任何情況下都不回傳內容。** 清單取自既有的 `SECRET_ENV_KEYS`，新增機密時自動涵蓋。 | P5 |
| FR-SET-05 ✅ | Prompt 版本為**唯讀清單**，不提供切換。版本由程式碼決定，且是 AI 快取鍵的一部分——切換等於讓既有解析全部失效。也不回傳 prompt 內文。 | P5 |
| FR-SET-06 ✅ | 維護作業為**手動觸發**，先預覽再執行，並回報實際處理筆數。不做自動排程：單機工具關機時排程不會執行，而會自行刪資料的背景程序風險高於效益。 | P5 |
| FR-SET-07 ✅ | 清理只刪除「已過期**且**沒有任何證據集合引用」的網頁快取；被引用的來源即使過期也保留，否則既有解析的引用會指向不存在的東西（違反驗收 #16）。證據集合本身一律不刪——它是既有解析的依據。 | P5 |
| FR-SET-08 ✅ | 可選擇一併重算全部錯題紀錄，走的是與作答流程相同的 `recompute`，不另寫一份邏輯。 | P5 |

## 10. 頁面

| 頁面 | 路徑 | 階段 |
|---|---|---|
| 首次初始化 | `/setup` | P1 |
| 登入 | `/login` | P1 |
| 首頁儀表板 | `/dashboard` | P2（統計於 P5 補強） |
| 科目管理 | `/subjects` | P1 |
| 章節管理 | `/subjects/[id]/chapters` | P1 |
| 題組管理 | `/question-groups` | P1 |
| 題目列表 | `/questions` | P1 |
| 題目新增／編輯 | `/questions/new`、`/questions/[id]/edit` | P1 |
| JSON 匯入 | `/imports/new` | P1 |
| 匯入預覽與錯誤修正 | `/imports/[id]` | P1 |
| 題組作答頁 | `/quiz/[sessionId]` | P2 |
| 作答結果頁 | `/quiz/[sessionId]/result` | P2 |
| 錯題本 ✅ | `/mistakes` | P2 |
| 單題詳細解析頁 ✅ | `/mistakes/[questionId]`（併入錯題詳情，不另開路由） | P4 |
| 多題整合分析頁 ✅ | `/analysis/aggregate` | P5 |
| 標籤管理頁 | `/tags` | P3 |
| AI 新標籤建議頁 | `/tags/suggestions` | P3 |
| 題庫答案衝突審核頁 | `/conflicts` | P4 |
| AI 任務與失敗工作頁 | `/ai/jobs` | P4 |
| AI 使用紀錄頁 ✅ | `/ai/usage` | P4（提前交付） |
| 系統設定頁 ✅ | `/settings` | P5（原標 P1，實際於 P5 交付） |

---

## 9. 驗收標準對照表

規格 §22 的 21 條驗收標準：

| # | 驗收標準 | 對應需求 | 階段 | 驗證方式 |
|---|---|---|---|---|
| 1 ✅ | 可建立科目、章節與題組 | FR-CAT-01～05 | P1 | E2E |
| 2 ✅ | 可匯入符合 Schema 的選擇題 JSON | FR-IMP-01～02 | P1 | 整合 + E2E |
| 3 ✅ | 錯誤 JSON 不會寫入正式題庫 | FR-IMP-03 | P1 | 整合測試 |
| 4 ✅ | 可預覽及修正匯入內容 | FR-IMP-04～06 | P1 | E2E |
| 5 ✅ | 可進行單選與複選作答 | FR-QUIZ-01～04 | P2 | E2E |
| 6 ✅ | 判分不依賴 AI | FR-QUIZ-10 | P2 | 單元測試 |
| 7 ✅ | 可選擇立即或交卷後顯示答案 | FR-QUIZ-07、11 | P2 | 整合 + E2E |
| 8 ✅ | 可保存作答歷史 | FR-QUIZ-12～13 | P2 | 整合測試 |
| 9 ✅ | 答錯題目進入錯題本 | FR-MIS-01 | P2 | 整合測試 |
| 10 ✅ | 可重新練習錯題 | FR-MIS-04 | P2 | E2E |
| 11 ✅ | 可管理受控知識點與錯誤類型 | FR-TAG-01～09 | P3 | 整合 + E2E |
| 12 ✅ | AI 不會未經審核建立正式標籤 | FR-TAG-06～07 | P3 | 整合測試 |
| 13 ✅ | 可啟動單題三階段 AI 分析 | FR-AI-01～03 | P4 | 整合 + E2E |
| 14 ✅ | 可顯示 AI 工作進度 | FR-JOB-03～04 | P4 | E2E |
| 15 ✅ | 可保存搜尋來源與引用 | FR-AI-06 | P4 | 整合測試 |
| 16 ✅ | AI 引用只指向實際存在來源 | FR-AI-07 | P4 | 單元 + 整合 |
| 17 ✅ | 答案衝突建立待審核紀錄 | FR-CONF-01～02 | P4 | 整合測試 |
| 18 ✅ | 爭議題不影響能力診斷 | FR-QUIZ-14、FR-CONF-04、FR-CONF-06～07 | P4 | 整合測試 |
| 19 ✅ | 可產生多題整合分析 | FR-AGG-01～09 | P5 | 整合 + E2E |
| 20 ✅ | Redis、PostgreSQL、NestJS、Next.js 可依文件完整啟動 | — | P0 | README 手動驗證 |
| 21 ✅ | lint、typecheck、test、build 全部通過 | — | 每階段 | `pnpm verify` |
