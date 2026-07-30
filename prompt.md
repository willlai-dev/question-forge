你是一名資深全端架構師、AI 應用工程師與產品工程師。請根據以下需求，規劃並實作一套「選擇題題庫、作答、對答案與 AI 錯題分析系統」。

請先完整分析需求、設計系統架構、資料模型、API 契約、AI 工作流程及開發里程碑。不得在尚未完成規劃與風險分析前直接大量撰寫程式碼。

# 一、專案定位

這是一套個人使用的題庫系統，目前只有一名使用者，因此第一版不需要處理大量併發、多租戶或複雜的商業計費。

主要用途：

1. 整理 PDF 題庫。
2. 將題目依科目、章節與題組分類。
3. 使用題庫進行選擇題作答。
4. 支援立即對答案或整份作答完成後對答案。
5. 記錄錯題與歷史作答資料。
6. 使用 NVIDIA AI 模型產生單題解析。
7. 使用 AI 分析單一錯題原因。
8. 整合多道錯題，分析共同問題與薄弱知識點。
9. 必要時搜尋公開網路資料，避免只依賴模型內部知識。
10. 保存 AI 使用過的資料來源、分析結果與引用。

目前題庫全部來自 PDF，但第一版不在網站內直接解析 PDF。

使用者會將系統提供的固定 Prompt 與 PDF 交給 GPT、Claude 或其他具備 PDF 閱讀能力的大型語言模型，讓外部模型整理為系統指定的 JSON 格式，再匯入本系統。

# 二、技術要求

請以以下技術為主要方案，不要任意更換核心技術：

## 前端

- Next.js
- TypeScript
- App Router
- Tailwind CSS
- shadcn/ui
- TanStack Query
- React Hook Form
- Zod

## 後端

- NestJS
- TypeScript
- REST API
- Swagger / OpenAPI
- Zod 或等效方式進行 request validation
- 必須有統一錯誤回應格式

## 資料庫

- 本地端 PostgreSQL
- Drizzle ORM
- Drizzle Kit migration
- 不使用 Prisma

## 背景工作與快取

- Redis
- BullMQ

Redis 主要用途：

- AI 工作佇列
- NVIDIA API 全域 rate limit
- 搜尋結果快取
- AI 結果短期快取
- 任務進度
- 任務去重
- 自動重試

永久資料仍然保存於 PostgreSQL，不得只保存在 Redis。

## AI 模型

主要模型：

nvidia/nemotron-3-ultra-550b-a55b

限制：

- 免費額度每分鐘最多 40 次請求。
- 目前只有一名使用者，可優先考慮回答品質，不必為多人併發過度最佳化。
- 仍需建立全域 rate limiter，避免非預期重試造成超額。
- AI provider 必須封裝，不得在各個 service 中直接散落 NVIDIA API 呼叫。

請建立類似以下抽象層：

- AiProvider
- NvidiaAiProvider
- AiGatewayService
- MockAiProvider

AI 呼叫必須保存：

- operation
- model
- promptVersion
- request status
- latency
- input/output token 數量，如 API 有提供
- reasoning effort
- error code
- retry count
- createdAt

## 網路搜尋

第一版可選擇以下其中一種搜尋服務：

- Tavily
- Brave Search API

請在規劃階段比較兩者，選擇較適合本專案的方案，並說明原因。

不得自行爬取 Google 搜尋結果頁面。

網站內容擷取應優先使用搜尋服務提供的 Extract 或 Context 功能。只有在必要時才實作有限制的網頁正文擷取。

# 三、題庫範圍

目前只支援選擇題：

1. 單選題。
2. 複選題。

第一版不實作：

- 填充題
- 簡答題
- 作文題
- 計算過程評分
- 圖片 OCR
- 網站內直接解析 PDF
- 主觀題 AI 評分

資料模型與程式碼可保留未來擴充能力，但不得因此將第一版過度抽象化。

# 四、題庫分類

題庫基本階層：

科目
→ 章節
→ 題組
→ 題目

要求：

- 科目可新增、修改、刪除及排序。
- 章節隸屬科目，可新增、修改、刪除及排序。
- 題組隸屬科目與章節。
- 章節可以允許為空，讓題組直接隸屬科目。
- 題組可以設定名稱、描述、來源、年份及備註。
- 題目可以在題組間移動。
- 題目可以搜尋、篩選及批次操作。

# 五、JSON 題庫匯入

請設計正式、具版本控制的 JSON 匯入格式。

至少包含：

- schemaVersion
- subject
- chapter
- questionGroup
- questions

每道題目至少包含：

- externalId
- questionNumber
- type
- stem
- options
- correctAnswers
- explanation
- sourcePage
- sourceReference
- reviewRequired
- reviewReason

選項至少包含：

- key
- text

題型只允許：

- single_choice
- multiple_choice

匯入流程：

1. 使用者上傳 JSON。
2. 系統驗證 JSON Schema。
3. 建立匯入批次。
4. 資料先進入暫存區。
5. 顯示匯入預覽。
6. 列出錯誤與警告。
7. 使用者可以修正、排除或確認題目。
8. 確認後才寫入正式題庫。

不得將未驗證資料直接寫入正式 questions 資料表。

驗證規則至少包含：

- schemaVersion 是否支援。
- 題型是否合法。
- 題幹是否為空。
- 是否至少有兩個選項。
- 選項 key 是否重複。
- 正確答案是否存在於選項中。
- 單選題是否只有一個正確答案。
- 複選題是否至少有兩個正確答案。
- externalId 是否重複。
- 題號是否重複。
- sourcePage 是否為合法值。
- explanation 缺失只能標示為空，不得自動編造。
- reviewRequired 題目必須在預覽介面醒目顯示。

請同時建立一份給使用者使用的 PDF 整理 Prompt，要求外部 AI：

- 只能輸出 JSON。
- 不得輸出 Markdown。
- 不得自行新增 PDF 不存在的題目。
- 不得改變題目原意。
- 必須保留完整題幹與選項。
- 必須保留題號與來源頁碼。
- 不確定答案時設定 reviewRequired。
- PDF 沒有解析時 explanation 必須為 null。
- 不得自行編造解析。
- 跨頁題目要合併。
- 選項統一使用 A、B、C、D 等大寫英文代號。

# 六、作答系統

使用者可以從科目、章節或題組開始作答。

支援：

- 順序出題。
- 隨機出題。
- 選項順序隨機。
- 指定題數。
- 只作答錯題。
- 只作答特定知識點。
- 即答模式。
- 整份交卷後顯示答案模式。
- 允許或禁止修改答案。
- 顯示作答進度。
- 顯示正確率。
- 顯示答題時間。

答案揭露模式：

- immediate
- after_submit

客觀題判分必須由程式完成，不得使用 AI 判定正確與否。

作答紀錄至少保存：

- quizSessionId
- questionId
- selectedAnswers
- correctAnswersSnapshot
- isCorrect
- responseTimeMs
- attemptNumber
- answeredAt
- answerChangedCount
- revealMode

題目或答案未來被修改時，歷史紀錄仍需保存當時版本或必要 snapshot。

# 七、錯題系統

答錯的題目自動加入錯題紀錄。

錯題頁面需要支援：

- 依科目篩選。
- 依章節篩選。
- 依題組篩選。
- 依知識點篩選。
- 依錯誤類型篩選。
- 顯示錯誤次數。
- 顯示最近答錯時間。
- 顯示是否已重新答對。
- 顯示連續答對次數。
- 重新練習錯題。
- 查看單題 AI 分析。
- 查看多題整合分析。

錯題不因答對一次就立即刪除。

請設計合理的錯題熟練狀態，例如：

- active
- improving
- mastered

可使用連續答對次數、近期正確率或其他可解釋規則判定。

# 八、受控標籤系統

標籤不得全部由 AI 自由生成，避免同義詞、近義詞及重複標籤失控。

請將分類拆為：

## 知識點標籤

代表題目考查內容。

每題限制：

- 主要知識點 1 個。
- 次要知識點最多 2 個。

## 能力類型

例如：

- 概念辨識
- 條件判斷
- 規則適用
- 案例推理
- 例外規則辨識
- 資料判讀

每題最多 1 個主要能力類型。

## 錯誤類型

例如：

- 概念混淆
- 忽略題目條件
- 例外規則遺漏
- 規則適用錯誤
- 選項比較錯誤
- 記憶錯誤
- 推理中斷
- 無法判定

AI 原則上只能從既有標籤中選擇。

若沒有適合的標籤，AI 只能提交 suggestedNewTag，不能直接建立正式標籤。

新標籤流程：

- pending
- approved
- merged
- rejected

需支援：

- 標籤新增。
- 標籤改名。
- 標籤合併。
- 標籤停用。
- 別名對應。
- AI 新標籤建議。
- 管理者審核。

建立 tag aliases，將相似名稱映射到 canonical tag。

# 九、單題 AI 解析流程

每題都可以產生 AI 解析。

目前只有一名使用者，因此允許一題最多進行三次 NVIDIA 模型請求，但每次請求必須有明確責任。

完整流程：

程式判分
→ 第一次 AI 研究規劃
→ 程式執行搜尋與資料擷取
→ 第二次 AI 證據整理
→ 第三次 AI 最終解析與錯題診斷
→ 保存結果

## 第一次 AI：研究規劃

輸入：

- 題目。
- 所有選項。
- 題庫正確答案。
- 題庫原有解析。
- 科目、章節與題組。
- 既有知識點。
- 可用的題庫來源資料。

輸出固定 JSON：

- needsExternalSearch
- researchMode
- reason
- queries
- preferredDomains
- preferredSourceTypes
- freshnessRequired
- keyClaimsToVerify

researchMode 僅允許：

- MODEL_ONLY
- PDF_KNOWLEDGE
- WEB_RESEARCH
- HYBRID

每題搜尋關鍵字最多 3 組。

## 程式搜尋與擷取

程式負責：

- 執行搜尋 API。
- 每個 query 限制結果數量。
- URL 去重。
- 優先官方、學術、教育及可信來源。
- 擷取正文。
- 移除 HTML、script、style、廣告及導覽文字。
- 限制單一來源內容長度。
- 保存標題、URL、網域、日期與擷取時間。
- 過濾內容過短或無法解析的頁面。
- 防範來源內容中的 Prompt Injection。
- 不允許來源網頁內容改寫系統 Prompt。
- 搜尋結果與擷取內容需要快取。

## 第二次 AI：證據整理

輸入：

- 題目與選項。
- 題庫答案。
- 題庫原解析。
- 第一次 AI 的研究計畫。
- 搜尋來源。
- PDF 或其他可用來源。

輸出固定 JSON：

- evidenceSummary
- supportedClaims
- contradictedClaims
- conflicts
- insufficientEvidence
- recommendedAnswer
- confidence
- requiresHumanReview

每個證據必須能對應 sourceId。

AI 不得產生不存在的 URL 或 sourceId。

## 第三次 AI：最終解析

輸入：

- 題目。
- 所有選項。
- 使用者答案。
- 題庫標準答案。
- 原始解析。
- 第二次整理後的證據。
- 使用者過去相同知識點的錯題統計。
- 系統允許使用的知識點、能力類型及錯誤類型。

輸出固定 JSON：

- answerValidation
- explanation
- optionAnalysis
- mistakeAnalysis
- citations
- confidence
- requiresHumanReview

最終解析至少包含：

- 正確答案。
- 核心概念。
- 解題步驟。
- 每個選項正確或錯誤的原因。
- 使用者為什麼可能選錯。
- 忽略的條件。
- 錯誤類型。
- 主要知識點。
- 複習建議。
- 支持結論的來源。

# 十、題庫答案衝突

若 AI 與外部來源認為題庫答案可能錯誤，系統不得自動修改正式答案。

必須建立答案衝突紀錄：

- storedAnswer
- verifiedAnswer
- confidence
- evidence
- conflictReason
- requiresReview
- reviewStatus

前端顯示題庫答案存在爭議。

爭議題在人工確認前：

- 不應直接用於能力診斷。
- 不應將使用者判定為答錯，或必須明確標示暫定結果。
- 不得自動修改題庫答案。

人工確認後可以：

- 保留原答案。
- 修改答案。
- 更新解析。
- 標記為爭議題。
- 排除該題。

# 十一、多題錯誤分析

多題分析不應直接將所有完整題目一次傳給模型。

先由 PostgreSQL 統計：

- 各科目正確率。
- 各章節正確率。
- 各題組正確率。
- 各知識點正確率。
- 各錯誤類型次數。
- 平均作答時間。
- 連續答錯次數。
- 重複錯誤概念。
- 近期正確率變化。
- 已改善與未改善項目。

再挑選代表錯題，交給 AI 產生整合分析。

整合分析輸出：

- 最薄弱知識點。
- 最常見錯誤類型。
- 相互關聯的錯誤模式。
- 優先複習順序。
- 推薦重新練習的題組或題目。
- 是否有改善。
- 具體學習建議。
- 分析依據及 confidence。

分析結果必須保存版本、模型、Prompt 版本與統計資料 snapshot。

# 十二、AI 快取與重複使用

同一道題不應每次都重新搜尋完整資料。

題目研究結果可以永久保存於 PostgreSQL，包括：

- 研究計畫。
- 搜尋關鍵字。
- 證據來源。
- 證據摘要。
- 標準解析。
- 選項解析。
- 知識點。
- 信心分數。
- 產生時間。
- Prompt 版本。
- 模型版本。

以下條件改變時才需要重新研究：

- 題目內容變更。
- 選項變更。
- 正確答案變更。
- Prompt 版本變更。
- 模型版本變更。
- 搜尋資料過期。
- 使用者手動要求重新分析。

個人化錯題分析可以根據以下內容建立 cache key：

- questionId
- questionVersion
- selectedAnswer
- correctAnswer
- promptVersion
- model

# 十三、BullMQ 工作設計

第一版 Queue 不要拆得過度複雜。

至少建立：

- question-analysis
- aggregate-analysis
- maintenance

question-analysis job 內執行完整流程：

1. researchPlan
2. webSearch
3. evidenceSynthesis
4. finalExplanation
5. saveResult

Job 需支援：

- pending
- active
- completed
- failed
- retrying
- cancelled

需保存進度：

- ANALYZING_QUESTION
- SEARCHING_SOURCES
- SYNTHESIZING_EVIDENCE
- GENERATING_EXPLANATION
- SAVING_RESULT
- COMPLETED

前端可使用輪詢方式每 1～2 秒取得進度。

第一版不必使用 WebSocket。

# 十四、NVIDIA API 限流與重試

建立 Redis 全域限流。

即使目前只有一名使用者，也不要無限制呼叫。

設定建議：

- 正常限制低於 40 RPM。
- 保留少量額度給重試。
- 所有 worker 共用同一組限流計數。
- 429 時依 Retry-After 或退避策略重試。
- 5xx 使用 exponential backoff。
- JSON Schema 驗證失敗可有限次重新生成。
- 不得無限重試。
- 相同 job 必須具備 idempotency。

AI 任務優先級：

1. 使用者正在等待的單題分析。
2. 使用者主動要求的多題分析。
3. 題庫匯入後的背景分析。
4. 維護與重新分析工作。

# 十五、主要資料表

請根據需求完成正式 ERD 與 Drizzle schema。

至少評估並設計以下資料表：

## 題庫

- users
- subjects
- chapters
- question_groups
- questions
- question_options
- question_sources
- question_versions

## 匯入

- import_batches
- import_questions
- import_validation_issues

## 標籤

- knowledge_tags
- skill_tags
- error_types
- question_knowledge_tags
- question_skill_tags
- tag_aliases
- tag_suggestions

## 作答

- quiz_sessions
- quiz_session_questions
- user_answers
- mistake_records

## AI

- ai_jobs
- ai_usage_logs
- prompt_versions
- question_ai_enrichments
- question_evidence_sets
- question_evidence_sources
- personalized_mistake_analyses
- aggregate_analyses
- answer_conflicts

請避免將所有資料都塞進 JSONB。

JSONB 只用於結構不固定、歷史 snapshot 或 AI 原始輸出；核心可查詢欄位必須正規化。

# 十六、主要頁面

至少規劃：

- 首頁儀表板。
- 科目管理。
- 章節管理。
- 題組管理。
- 題目列表。
- 題目新增與編輯。
- JSON 匯入。
- 匯入預覽與錯誤修正。
- 題組作答頁。
- 作答結果頁。
- 錯題本。
- 單題詳細解析頁。
- 多題整合分析頁。
- 標籤管理頁。
- AI 新標籤建議頁。
- 題庫答案衝突審核頁。
- AI 任務與失敗工作頁。
- AI 使用紀錄頁。
- 系統設定頁。

# 十七、安全要求

即使目前只有單一使用者，也需有基本安全設計：

- 密碼雜湊。
- HttpOnly Cookie 或安全 token 機制。
- CSRF 風險評估。
- 輸入驗證。
- JSON 上傳大小限制。
- API rate limit。
- 敏感環境變數不得暴露到前端。
- NVIDIA API Key 只能存在後端。
- Search API Key 只能存在後端。
- 防止 SSRF。
- 只允許 http/https。
- 禁止存取 localhost、私有 IP、metadata service 等位址。
- 網頁擷取需限制 timeout、response size 與 redirect 次數。
- 外部網頁內容一律視為不可信資料。
- 防止搜尋結果 Prompt Injection。
- AI 回傳內容必須經 Schema validation。
- AI 不得直接執行資料庫寫入或任意工具。

# 十八、測試要求

不得只做 happy path。

至少包含：

## 單元測試

- JSON 匯入驗證。
- 單選題判分。
- 複選題判分。
- 選項順序隨機後的答案映射。
- 錯題狀態更新。
- 標籤別名映射。
- 標籤合併。
- AI JSON Schema 驗證。
- cache key。
- NVIDIA rate limiter。
- answer conflict 規則。

## 整合測試

- 匯入批次確認後寫入正式題庫。
- 作答並建立錯題紀錄。
- BullMQ 任務建立、執行及重試。
- NVIDIA provider mock。
- Search provider mock。
- AI 分析完成後保存結果。
- 爭議答案不計入正式能力分析。

## E2E

- 登入。
- 建立科目與題組。
- 匯入 JSON。
- 預覽並確認。
- 開始作答。
- 即答模式。
- 交卷模式。
- 查看錯題。
- 啟動單題 AI 分析。
- 查看分析進度與結果。
- 查看多題整合分析。

# 十九、開發階段

請先提出合理的 milestone 規劃，再依序實作。

建議階段：

## Phase 0：架構與契約

- 完整功能規格。
- 系統架構。
- ERD。
- API 契約。
- JSON 匯入 Schema。
- AI 輸入輸出 Schema。
- 錯誤回應格式。
- Prompt 版本規則。
- 開發環境與 Docker Compose。

## Phase 1：題庫核心

- Auth。
- 科目、章節、題組。
- 選擇題 CRUD。
- JSON 匯入。
- 匯入預覽。
- 匯入驗證。
- 題庫搜尋。

## Phase 2：作答與錯題

- Quiz session。
- 單選與複選判分。
- 即答模式。
- 交卷模式。
- 作答歷史。
- 錯題本。
- 錯題熟練狀態。

## Phase 3：標籤系統

- 知識點。
- 能力類型。
- 錯誤類型。
- 別名。
- 合併。
- AI 建議審核。

## Phase 4：AI 與搜尋

- NVIDIA provider。
- Search provider。
- Redis。
- BullMQ。
- 三階段單題分析。
- AI 使用紀錄。
- 搜尋來源與引用。
- 答案衝突。

## Phase 5：多題分析與管理功能

- 統計彙總。
- 多題錯誤分析。
- AI 任務管理。
- 失敗任務重跑。
- Prompt 版本管理。
- AI 用量頁面。

每個 Phase 都必須：

- 完成程式碼。
- 完成 migration。
- 完成測試。
- 更新文件。
- 確認 lint、typecheck、test、build 通過。
- 建議建立獨立 Git commit。

# 二十、Agent 工作方式

請依以下順序工作：

1. 先檢查現有 repository。
2. 說明目前專案狀態。
3. 提出完整系統設計。
4. 列出關鍵技術決策與替代方案。
5. 列出風險與處理方式。
6. 提出資料庫 ERD。
7. 提出 API 路由。
8. 提出 JSON Schema。
9. 提出 AI input/output Schema。
10. 提出 milestone。
11. 等規劃完整後再開始實作。
12. 實作時依 milestone 執行，不得跨階段混亂修改。
13. 每完成一個 milestone，執行 lint、typecheck、unit test、integration test、E2E 與 build。
14. 發現規格衝突時，優先選擇資料正確性、可追蹤性與簡單可維護方案。
15. 不要為單一使用者過度設計微服務。
16. 先採模組化單體架構。
17. 前後端若為不同 repository，必須以共享 OpenAPI 與 Schema 文件對接。
18. 不得假裝測試通過；必須提供實際指令與結果。
19. 不得刪除既有功能或資料，除非有明確理由並先記錄。
20. 不得在沒有 migration 的情況下直接修改資料庫結構。

# 二十一、預期交付物

請至少交付：

- SYSTEM_DESIGN.md
- FUNCTIONAL_REQUIREMENTS.md
- ARCHITECTURE.md
- ERD.md
- API_CONTRACT.md
- QUESTION_IMPORT_SCHEMA.json
- QUESTION_IMPORT_PROMPT.md
- AI_ANALYSIS_SCHEMAS.md
- AI_PROMPTS.md
- SECURITY.md
- TEST_PLAN.md
- IMPLEMENTATION_PLAN.md
- README.md
- .env.example
- docker-compose.yml
- Drizzle schema 與 migrations
- Swagger / OpenAPI 文件
- 完整前端與後端程式碼
- 單元、整合及 E2E 測試
- 最終實作報告

# 二十二、驗收標準

系統至少需達到：

1. 可以建立科目、章節與題組。
2. 可以匯入符合 Schema 的選擇題 JSON。
3. 錯誤 JSON 不會寫入正式題庫。
4. 可以預覽及修正匯入內容。
5. 可以進行單選題與複選題作答。
6. 判分不依賴 AI。
7. 可以選擇立即顯示答案或交卷後顯示。
8. 可以保存作答歷史。
9. 答錯題目會進入錯題本。
10. 可以重新練習錯題。
11. 可以管理受控知識點與錯誤類型。
12. AI 不會未經審核自由建立正式標籤。
13. 可以啟動單題三階段 AI 分析。
14. 可以顯示 AI 工作進度。
15. 可以保存搜尋來源與引用。
16. AI 引用只能指向實際存在的來源。
17. 題庫答案與外部證據衝突時會建立待審核紀錄。
18. 爭議題不會錯誤影響能力診斷。
19. 可以產生多題錯誤整合分析。
20. Redis、PostgreSQL、NestJS 與 Next.js 可透過文件完整啟動。
21. lint、typecheck、test 與 build 全部通過。

請先輸出完整規劃，不要立刻跳到大量程式碼實作。規劃中若有必要調整上述細節，可以提出修改，但不得移除核心功能，且必須清楚說明理由、影響與替代方案。

# 環境變數與密鑰管理

我只會手動提供以下三個環境變數：

```env
NVIDIA_API_KEY=
TAVILY_API_KEY=
DATABASE_URL=
```

除此之外，不要要求我手動申請或提供其他環境變數。其餘設定請由你完成。

要求：

1. 建立完整的 `.env.example`，但不得填入任何真實密鑰。
2. 真實 `.env` 必須加入 `.gitignore`。
3. 不得將任何 API Key、資料庫密碼或 authentication secret 寫死在程式碼中。
4. 自動產生開發環境所需的安全隨機密鑰，例如：
   - `JWT_ACCESS_SECRET`
   - `JWT_REFRESH_SECRET`
   - `COOKIE_SECRET`
   - 其他必要的簽章或加密密鑰

5. 自動設定以下非秘密變數的合理開發預設值：
   - `NODE_ENV`
   - `PORT`
   - `FRONTEND_URL`
   - `BACKEND_URL`
   - `CORS_ORIGIN`
   - `NVIDIA_API_BASE_URL`
   - `NVIDIA_MODEL=nvidia/nemotron-3-ultra-550b-a55b`
   - NVIDIA RPM 限制
   - BullMQ retry、timeout 與 concurrency
   - Tavily 搜尋數量與快取時間

6. Redis 請透過 Docker Compose 建立本地服務，並由系統產生所需的 `REDIS_URL` 與安全密碼，不要求我另外申請 Redis 服務。
7. PostgreSQL 不要在 Docker Compose 中重建，直接使用我提供的 `DATABASE_URL`。
8. 啟動時需檢查三個必要變數是否存在；缺失時提供明確錯誤訊息，但不得在 log 中印出其內容。
9. 前端只能取得必要的公開變數，例如 `NEXT_PUBLIC_API_URL`。
10. 以下變數不得暴露至前端：
    - `NVIDIA_API_KEY`
    - `TAVILY_API_KEY`
    - `DATABASE_URL`
    - `REDIS_URL`
    - JWT secrets
    - Cookie secrets

11. 系統目前只有一名使用者。請實作安全的首次啟動帳號建立流程，可採以下其中一種：
    - 第一次開啟系統時進入初始化頁面建立帳號；建立完成後永久停用初始化頁面。
    - 提供一次性 CLI seed 指令，讓我在終端輸入帳號與密碼。

12. 不要要求我把初始帳號密碼放進 `.env`。
13. 所有環境變數必須經過啟動時 Schema validation。
14. 提供清楚的本地啟動文件，說明我只需填入上述三個變數即可啟動。
