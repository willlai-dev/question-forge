# 系統設計總覽（SYSTEM_DESIGN）

> 版本：0.1.0（Phase 0）
> 最後更新：2026-07-30

本文件是整套系統的入口。細節分散在以下文件，本文只負責「全局觀點與決策理由」：

| 文件 | 內容 |
|---|---|
| [FUNCTIONAL_REQUIREMENTS.md](./FUNCTIONAL_REQUIREMENTS.md) | 功能規格與驗收標準對照 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 系統架構、模組邊界、部署與資料流 |
| [ERD.md](./ERD.md) | 資料模型與關鍵約束 |
| [API_CONTRACT.md](./API_CONTRACT.md) | REST API 契約與統一錯誤格式 |
| [QUESTION_IMPORT_SCHEMA.json](./QUESTION_IMPORT_SCHEMA.json) | 題庫匯入 JSON Schema |
| [QUESTION_IMPORT_PROMPT.md](./QUESTION_IMPORT_PROMPT.md) | 給外部 LLM 整理 PDF 用的固定 Prompt |
| [AI_ANALYSIS_SCHEMAS.md](./AI_ANALYSIS_SCHEMAS.md) | AI 三階段輸入／輸出 Schema |
| [AI_PROMPTS.md](./AI_PROMPTS.md) | AI Prompt 內容與版本規則 |
| [SECURITY.md](./SECURITY.md) | 安全設計與威脅處理 |
| [TEST_PLAN.md](./TEST_PLAN.md) | 單元、整合、E2E 測試計畫 |
| [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) | Phase 0～5 里程碑 |

---

## 1. 專案定位

一套**單一使用者**的個人題庫系統。核心價值不在「刷題」，而在**把答錯的題目變成可解釋、可追蹤、可複習的知識缺口**。

四條主線：

1. **題庫整理** — PDF 由外部 LLM 轉成本系統指定的 JSON，經驗證與人工確認後匯入。
2. **作答** — 支援單選／複選，即答或交卷後對答案，判分完全由程式執行。
3. **錯題追蹤** — 答錯自動進錯題本，以可解釋規則維護熟練狀態。
4. **AI 分析** — 單題三階段深度解析（含網路查證），以及多題整合的弱點診斷。

### 明確不做（第一版）

填充題、簡答題、作文題、計算過程評分、圖片 OCR、**網站內直接解析 PDF**、主觀題 AI 評分、多租戶、商業計費。

資料模型保留未來擴充空間（例如 `questions.type` 為列舉、題型相關邏輯集中在判分模組），但不為了假想需求而過度抽象。

---

## 2. 規劃階段的實測結論

架構決策不建立在假設上。以下事實是規劃時直接呼叫外部 API 驗證得到的，並直接決定了設計：

| 驗證項目 | 結果 | 設計影響 |
|---|---|---|
| 模型 `nvidia/nemotron-3-ultra-550b-a55b` | 存在且金鑰可用 | 規格指定的模型無需替換 |
| `response_format: json_schema` + `strict: true` | **伺服器端強制生效** | 「輸出固定 JSON」由 API 保證，不必靠 prompt 祈禱 |
| `reasoning_effort` | 真實參數，enum：`none / minimal / low / medium / high / xhigh / max` | 成為三階段的品質與延遲調節桿，並可記錄於 `ai_usage_logs` |
| `usage` 欄位 | 提供 prompt / completion / total tokens | 用量紀錄可存真實數字 |
| 限流回應標頭 | **完全沒有** | Redis 限流器是唯一權威，不能等 API 告訴我們超額 |
| 未知參數 | 硬性 400 拒絕 | Provider 只能送白名單參數 |
| 錯誤格式 | `{"error":{message,type,code}}` | 錯誤映射有明確依據 |
| `reasoning_effort: "none"` | 輸出 schema 合法但**語意自我矛盾**（`needsExternalSearch: true` 卻 `researchMode: "MODEL_ONLY"`） | **Schema 驗證不足**，必須加跨欄位語意驗證 |
| 延遲 | 極簡 prompt 已需 4～8 秒；伺服器自報排隊 41 筆 | 分析必為非同步 Job + 輪詢 |
| Tavily `/search` 與 `/extract` | 皆可用，`/extract` 回傳乾淨 markdown | 選定 Tavily，並可免除自行爬取 |

> 最後一項最關鍵：**結構正確不代表內容正確**。系統因此在 Zod schema 驗證之外，另有一層跨欄位語意驗證（見 [AI_ANALYSIS_SCHEMAS.md](./AI_ANALYSIS_SCHEMAS.md)）。

---

## 3. 核心設計原則

### 3.1 正確性優先於自動化

規格 §20.14 要求衝突時優先選資料正確性與可追蹤性。落實方式：

- **判分只由程式做**。AI 永遠不決定對錯。
- **AI 不能寫資料庫**。所有 AI 輸出經 Zod 驗證 + 參照完整性檢查後，由 service 寫入。
- **AI 不能建立正式標籤**。只能從既有受控詞彙中選，否則提交 `tag_suggestions` 待審。
- **AI 不能改題庫答案**。與外部證據衝突時建立 `answer_conflicts` 待人工裁決。
- **爭議題不汙染診斷**。待審期間該題作答標記為 provisional，統計一律排除。

### 3.2 可追蹤性

每一個 AI 結論都必須能回答「你憑什麼這樣說」：

- 每次模型呼叫都寫入 `ai_usage_logs`（operation、model、promptVersion、status、latency、token、reasoning effort、error code、retry count）。
- 每個證據都對應 `question_evidence_sources` 中一筆真實來源，含 URL、網域、標題、擷取時間。
- **引用只能指向實際存在的 sourceId**：儲存前驗證 `citations ⊆ sourceIds`，不符者剔除並標記需人工複核。
- 分析結果保存 prompt 版本、模型版本與統計 snapshot，日後可重現。

### 3.3 不為單一使用者過度設計

- 模組化單體，不是微服務（規格 §20.15、§20.16）。
- 佇列只有三條：`question-analysis`、`aggregate-analysis`、`maintenance`。
- Worker 預設與 API 同進程，需要時以 `WORKER_INLINE=false` 切成獨立進程。
- 不做 WebSocket，前端 1～2 秒輪詢即可。

### 3.4 外部內容一律不可信

搜尋結果與網頁正文是**資料**，不是指令。防護見 [SECURITY.md](./SECURITY.md)：分隔標記、長度上限、合成 sourceId、citation 白名單驗證、SSRF 封鎖清單。

---

## 4. 關鍵技術決策

### 4.1 搜尋服務：選 Tavily（規格 §二要求比較後選定）

| 面向 | Tavily | Brave Search API |
|---|---|---|
| 搜尋結果 | ✔ 附 relevance score 與內容摘要 | ✔ |
| **正文擷取** | ✔ **first-party `/extract`，直接回乾淨 markdown** | ✘ 需自行抓取與清洗 |
| 失敗處理 | ✔ 回傳 `failed_results` 陣列 | 自行處理 |
| 對 SSRF 的影響 | 由 Tavily 代抓，我方几乎不需直連任意 URL | 必須自行連外，SSRF 面積大 |
| 實測 | 兩個端點皆已驗證可用 | 未提供金鑰 |

**決定：Tavily。** 理由有三：

1. `/extract` 直接滿足規格「優先使用搜尋服務提供的 Extract 功能」，並讓「限制正文長度、移除 HTML/script/廣告」這些需求由服務端完成，我方程式碼與攻擊面都小得多。
2. Brave 需要另外實作抓取器，等於把規格明文想避免的風險（SSRF、正文清洗）自己扛回來。
3. 使用者只提供 `TAVILY_API_KEY`，而規格明令不得要求申請其他金鑰。

仍以 `SearchProvider` 介面封裝，未來換 Brave 只需新增一個實作。

### 4.2 AI 輸出的雙層驗證

```
NVIDIA json_schema (strict)  →  結構一定正確
        ↓
Zod schema 驗證              →  型別與範圍再確認（防 provider 行為變動）
        ↓
Zod superRefine 語意驗證     →  跨欄位一致性（實測證明必要）
        ↓
參照完整性檢查               →  citations / tagId 必須真實存在
        ↓
才允許寫入資料庫
```

語意驗證的實例（皆來自規格語義或實測問題）：

- `needsExternalSearch === true` 時 `researchMode` 不得為 `MODEL_ONLY`。
- `researchMode === 'WEB_RESEARCH'` 時 `queries` 不得為空。
- `citations` 中每個 `sourceId` 必須存在於本次證據集合。
- `answerValidation.agreesWithStoredAnswer === false` 時必須提供 `conflictReason`。
- 單選題的 `recommendedAnswer` 不得有多個選項。

任一層失敗 → 有限次重生（`NVIDIA_MAX_SCHEMA_REGENERATIONS=2`），仍失敗則 job 標記 `failed` 並保留原始輸出供除錯。**絕不無限重試。**

### 4.3 三階段 reasoning effort 分級

| 階段 | 任務性質 | effort | 理由 |
|---|---|---|---|
| 研究規劃 | 判斷要不要查、查什麼 | `low` | 決策簡單，但實測 `none` 會語意矛盾，所以不用 `none` |
| 證據整理 | 比對來源與題目，找矛盾 | `medium` | 需要推理，但有明確材料 |
| 最終解析 | 逐選項解釋、診斷錯因 | `high` | 品質直接決定產品價值；單一使用者可負擔延遲 |

`reasoning_effort` 會連同結果寫入 `ai_usage_logs`，日後可用實際數據調整。

### 4.4 限流：客戶端權威

免費額度 40 RPM，且 **API 不回傳任何限流標頭**，所以：

- Redis Lua 腳本做原子化滑動視窗計數，所有 worker 共用 `ratelimit:nvidia:global`。
- `NVIDIA_MAX_RPM=30` + `NVIDIA_RETRY_RESERVE_RPM=8`，合計 38 < 40。啟動時由 env schema 強制檢查此不變式。
- 併發上限 2：實測伺服器端已在排隊，提高併發只會拉長個別延遲。

### 4.5 選項隨機化與判分解耦

`quiz_session_questions.option_order` 存打亂後的選項 key 序列（例如 `['C','A','D','B']`）。

- 前端只拿到這個順序，不知道哪個是對的。
- 判分永遠拿使用者送回的**真實 key** 比對 `correct_answers_snapshot`。
- 因此「選項順序隨機後的答案映射」可以被純函式單元測試覆蓋，不需要跑 UI。

### 4.6 快取失效以內容雜湊為準

`questions.content_hash = sha256(正規化的 stem + options + correctAnswers)`。

題目研究結果（`question_ai_enrichments`）只在下列情況失效並重跑：內容雜湊變更、prompt 版本變更、模型版本變更、證據過期（`EVIDENCE_STALE_AFTER_DAYS`）、使用者手動要求。

個人化錯題分析另用 `cache_key = hash(questionId, questionVersion, selectedAnswer, correctAnswer, promptVersion, model)`——同一題同一種錯法只算一次。

---

## 5. 系統邊界

```
┌──────────────┐         ┌──────────────────────────────┐
│  Next.js     │ ──────► │  NestJS API（模組化單體）     │
│  App Router  │  CORS   │  REST + Swagger              │
└──────────────┘  Cookie └───────┬──────────────────────┘
                                 │
              ┌──────────────────┼───────────────────┐
              ▼                  ▼                   ▼
       ┌────────────┐    ┌────────────┐      ┌──────────────┐
       │ PostgreSQL │    │   Redis    │      │ BullMQ Worker│
       │ 永久資料    │    │ 佇列/限流   │      │ 三階段分析    │
       └────────────┘    │ 快取/進度   │      └──────┬───────┘
                         └────────────┘             │
                                        ┌───────────┴──────────┐
                                        ▼                      ▼
                                ┌───────────────┐     ┌────────────────┐
                                │ NVIDIA NIM API│     │ Tavily API     │
                                │ （唯一 AI 出口）│     │ search/extract │
                                └───────────────┘     └────────────────┘
```

**永久資料一律落在 PostgreSQL。** Redis 只放佇列、限流計數、進度、去重鍵與可重建的快取——全部清空後系統仍應能正常運作，只是變慢。

---

## 6. 主要風險與處理

| 風險 | 影響 | 處理 |
|---|---|---|
| 模型延遲高、免費額度壅塞 | 單題分析可能數十秒至數分鐘 | 非同步 Job + 進度輪詢；分級 effort；結果永久快取 |
| Reasoning token 計入 completion，可能截斷 JSON | 輸出不完整 | 記錄 `finish_reason`，`length` 視為失敗並提高上限重試一次 |
| 結構合法但語意矛盾（已實測） | 錯誤結論進資料庫 | 跨欄位語意驗證 + 有限次重生 |
| 無限流標頭 | 可能超額 | 客戶端 Redis 原子限流；保留重試額度 |
| 專案路徑含非 ASCII 字元 | 工具鏈異常 | Compose 明確指定 `name: qba`（否則專案名被正規化成空字串而報錯）；不使用 bind mount |
| 本機未安裝 psql | 無法用 CLI 建資料庫 | 全部走 Drizzle Kit / node-postgres；附 `scripts/create-test-db.mjs` |
| 免費額度或模型變動 | 開發受阻 | `MockAiProvider` / `MockSearchProvider`；模型名稱走環境變數 |
| Tavily 額度消耗 | 查詢受限 | Redis 快取 + `web_documents` 跨題重用；每題最多 3 組查詢 |
| `after_submit` 模式答案洩漏 | 作弊、破壞測驗意義 | API 契約層測試鎖定「未交卷不得回傳正確答案」 |
| PostgreSQL enum 演進不便 | migration 卡住 | 固定集合才用 `pgEnum`；易變者用查表 |

---

## 7. 驗收標準對照

規格 §22 的 21 條驗收標準，逐條對應到實作階段與測試，見 [FUNCTIONAL_REQUIREMENTS.md 第 9 節](./FUNCTIONAL_REQUIREMENTS.md#9-驗收標準對照表)。
