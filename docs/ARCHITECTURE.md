# 系統架構（ARCHITECTURE）

> 版本：0.1.0（Phase 0）

---

## 1. 架構選型：模組化單體

規格 §20.15、§20.16 明令「不要為單一使用者過度設計微服務，先採模組化單體架構」。

實作方式是**單一 NestJS 應用程式、多個界線清楚的模組**：模組之間只透過 service 介面互相呼叫，不共用彼此的 repository。日後若真的需要拆分，模組邊界就是切割線。

### Monorepo 結構

```
題庫分析/
├─ apps/
│  ├─ api/                    NestJS 後端
│  │  └─ src/
│  │     ├─ main.ts           啟動：env 驗證 → CORS → Swagger → 全域錯誤處理
│  │     ├─ app.module.ts     根模組
│  │     ├─ config/           環境變數載入與驗證
│  │     ├─ common/           統一錯誤、request id、守衛、攔截器
│  │     ├─ infra/            PostgreSQL 與 Redis 連線（唯一建立處）
│  │     └─ modules/          業務模組（見下）
│  └─ web/                    Next.js App Router 前端
│     └─ src/
│        ├─ app/              路由與頁面
│        ├─ components/       UI 元件（shadcn/ui）
│        └─ lib/              API client、工具函式
├─ packages/
│  ├─ contracts/              前後端共用 Zod 契約（唯一真相來源）
│  └─ db/                     Drizzle schema、migration、連線工廠
├─ docs/                      設計文件
├─ scripts/                   bootstrap-env、建立測試資料庫
└─ docker-compose.yml         只有 Redis
```

### 為什麼是 monorepo 而不是兩個 repo

規格 §20.17 允許前後端分開，但要求以共享 OpenAPI 與 Schema 對接。單一 repo 讓 `packages/contracts` 成為唯一契約來源：

- 後端用它做 request validation。
- 前端用它做 React Hook Form 的 resolver。
- 兩邊共用同一份錯誤碼與型別。

省掉跨 repo 的版本同步與 client 產生流程，對單人專案是明顯淨收益。

### 後端模組清單

| 模組 | 職責 | 階段 |
|---|---|---|
| `AuthModule` | 首次初始化、登入、token 輪替、CSRF | P1 |
| `SubjectsModule` / `ChaptersModule` / `QuestionGroupsModule` | 題庫階層 CRUD 與排序 | P1 |
| `QuestionsModule` | 題目 CRUD、搜尋、批次操作、版本快照 | P1 |
| `ImportsModule` | 上傳、驗證、暫存、預覽、修正、commit | P1 |
| `QuizModule` | 場次建立、出題、**判分**、交卷、結果 | P2 |
| `MistakesModule` | 錯題紀錄、熟練狀態、重練 | P2 |
| `TagsModule` | 受控詞彙、別名、合併、AI 建議審核 | P3 |
| `AiModule` | AiGateway、Provider、佇列、三階段流程 | P4 |
| `SearchModule` | SearchProvider、擷取、清洗、快取 | P4 |
| `ConflictsModule` | 答案衝突建立與裁決 | P4 |
| `StatsModule` | PostgreSQL 統計彙總 | P5 |
| `SettingsModule` / `HealthModule` | 系統設定、健康檢查 | P0／P1 |

---

## 2. 執行期拓撲

```
┌─────────────────────┐
│  Next.js  :3000     │
│  App Router / RSC   │
└──────────┬──────────┘
           │ fetch（credentials: include）
           │ CORS + HttpOnly Cookie + X-CSRF-Token
           ▼
┌─────────────────────────────────────────────┐
│  NestJS  :4000   前綴 /api/v1               │
│  ┌──────────────────────────────────────┐   │
│  │ RequestId → Auth Guard → CSRF Guard  │   │
│  │ → Zod 驗證 → Controller → Service    │   │
│  │ → AllExceptionsFilter（統一錯誤）    │   │
│  └──────────────────────────────────────┘   │
│                                             │
│  BullMQ Worker（預設同進程，可切分離）        │
└───────┬──────────────────┬──────────────────┘
        │                  │
        ▼                  ▼
┌───────────────┐   ┌──────────────┐
│ PostgreSQL    │   │ Redis :6379  │
│ 永久資料       │   │ 佇列/限流/快取 │
│（使用者既有）   │   │（Docker）     │
└───────────────┘   └──────┬───────┘
                           │ worker 對外
              ┌────────────┴────────────┐
              ▼                         ▼
     ┌─────────────────┐      ┌──────────────────┐
     │ NVIDIA NIM API  │      │ Tavily API       │
     │ AiGatewayService│      │ SearchProvider   │
     │ 唯一出口         │      │ search + extract │
     └─────────────────┘      └──────────────────┘
```

### 各儲存體的職責界線

| 儲存體 | 存什麼 | 不存什麼 |
|---|---|---|
| PostgreSQL | 所有永久資料：題庫、作答、錯題、標籤、AI 結果、證據來源、使用紀錄 | 暫時性佇列狀態 |
| Redis | 佇列、限流計數、任務進度鏡像、去重鍵、搜尋與擷取快取 | **任何唯一真相**。Redis 全清後系統仍應正常，只是變慢 |

Redis 設定 `maxmemory-policy noeviction`：BullMQ 的 job 資料若被 evict 會造成任務靜默消失，寧可寫入失敗也不要被淘汰。

### Worker 部署模式

`WORKER_INLINE=true`（預設）時 worker 與 API 同進程，啟動最單純。
設為 `false` 時 API 只負責入列，另以獨立進程啟動 worker，兩者共用同一組 Redis 限流計數。

---

## 3. AI 層抽象

規格 §二要求「AI provider 必須封裝，不得在各個 service 中直接散落 NVIDIA API 呼叫」。

```
業務 service（QuizModule / AiModule / ...）
        │  只認識這一層
        ▼
┌──────────────────────────────────────────────┐
│ AiGatewayService                             │
│  · Redis 全域限流（Lua 原子計數）              │
│  · 併發閘門                                   │
│  · 重試與退避                                 │
│  · Zod schema + 語意驗證                      │
│  · 結果快取                                   │
│  · 寫入 ai_usage_logs                        │
└───────────────┬──────────────────────────────┘
                │ 依 AI_PROVIDER 切換
     ┌──────────┴──────────┐
     ▼                     ▼
┌──────────────────┐  ┌─────────────────┐
│ NvidiaAiProvider │  │ MockAiProvider  │
│ 唯一知道 NVIDIA   │  │ 決定性 fixture   │
│ HTTP 細節的地方   │  │ 測試與 E2E 用     │
└──────────────────┘  └─────────────────┘
```

`AiProvider` 介面（Phase 4 實作）：

```ts
interface AiProvider {
  readonly name: 'nvidia' | 'mock';
  complete<T>(request: AiCompletionRequest<T>): Promise<AiCompletionResult<T>>;
}

interface AiCompletionRequest<T> {
  operation: AiOperation;          // research_plan | evidence_synthesis | final_explanation | aggregate_analysis
  promptVersion: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;            // Zod schema
  jsonSchema: object;              // 送給 API 的 JSON Schema（strict）
  reasoningEffort: ReasoningEffort;
  maxTokens: number;
  temperature: number;
}

interface AiCompletionResult<T> {
  data: T;
  raw: unknown;                    // 原始回應，寫入 raw_output 供追溯
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  finishReason: string;
  latencyMs: number;
  retryCount: number;
}
```

搜尋層同構：`SearchProvider` ← `TavilySearchProvider` / `MockSearchProvider`。

### 為什麼一定要有 MockAiProvider

1. E2E 測試必須決定性——真實模型每次輸出不同，且延遲 4～8 秒以上。
2. 免費額度有限，測試不該消耗。
3. 免費服務若暫時不可用，開發不能因此停擺。

---

## 4. 單題分析資料流

```
使用者點「分析這題」
    │
    ▼
POST /ai/questions/:id/analyze
    │  計算 idempotencyKey = hash(op, questionId, contentHash, promptVersion, model, selectedAnswer)
    │  若已有相同 key 的 job → 直接回傳既有 jobId（不重複執行）
    │  若已有可重用的 enrichment → 直接回結果
    ▼
建立 ai_jobs 列 + BullMQ 入列（jobId = idempotencyKey，priority 依任務類型）
    │
    ▼  worker 取出
┌──────────────────────────────────────────────────────────┐
│ ① ANALYZING_QUESTION      AI#1 研究規劃（effort=low）      │
│    輸入：題目、選項、正確答案、原解析、科目章節題組、既有知識點 │
│    輸出：needsExternalSearch / researchMode / queries…    │
├──────────────────────────────────────────────────────────┤
│ ② SEARCHING_SOURCES       程式執行（無 AI）                │
│    Tavily /search（最多 3 組 query）→ URL 去重 → 可信度排序 │
│    → Tavily /extract 取正文 → 長度截斷 → 指派 sourceId S1..Sn│
│    → 寫入 question_evidence_sources、快取到 Redis 與       │
│      web_documents                                       │
├──────────────────────────────────────────────────────────┤
│ ③ SYNTHESIZING_EVIDENCE   AI#2 證據整理（effort=medium）   │
│    外部內容包在不可信分隔標記內                             │
│    輸出：evidenceSummary / supportedClaims / conflicts…    │
│    驗證：每個證據的 sourceId 必須存在                       │
├──────────────────────────────────────────────────────────┤
│ ④ GENERATING_EXPLANATION  AI#3 最終解析（effort=high）     │
│    輸入另含：使用者答案、同知識點歷史錯題統計、             │
│              系統允許的知識點／能力類型／錯誤類型            │
│    輸出：answerValidation / explanation / optionAnalysis / │
│          mistakeAnalysis / citations…                     │
├──────────────────────────────────────────────────────────┤
│ ⑤ SAVING_RESULT           程式寫入                        │
│    · question_ai_enrichments（is_current 唯一）           │
│    · personalized_mistake_analyses（cache_key 唯一）      │
│    · 標籤只能對應既有 tag；對不上 → tag_suggestions        │
│    · 若 answerValidation 不同意題庫答案 → answer_conflicts │
│      並將題目標為 disputed（**不修改答案**）               │
└──────────────────────────────────────────────────────────┘
    │
    ▼  COMPLETED
前端每 1.5 秒輪詢 GET /ai/jobs/:id，終態即停止
```

進度同時寫入 Redis（BullMQ progress）與 PostgreSQL（`ai_jobs.progress_step`）。**輪詢讀 PostgreSQL**：即使 Redis 被清空，使用者仍看得到任務狀態。

---

## 5. 限流與重試

### 全域限流

所有 worker 共用 Redis key `ratelimit:nvidia:global`，以 Lua 腳本原子執行「檢查 + 遞增」，避免多 worker 競態。

- 一般任務可用額度：`NVIDIA_MAX_RPM`（30）
- 重試專用保留額度：`NVIDIA_RETRY_RESERVE_RPM`（8）
- 合計 38 < 免費上限 40。此不變式由 `validateEnv()` 在啟動時強制檢查。

**為何不靠 API 回饋**：實測 NVIDIA 回應不含任何 `X-RateLimit-*` 或 `Retry-After` 標頭，客戶端計數是唯一可靠來源。

### 重試矩陣

| 情況 | 策略 | 上限 |
|---|---|---|
| HTTP 429 | 有 `Retry-After` 就照做；否則指數退避 + jitter | `NVIDIA_MAX_RETRIES_429`（5） |
| HTTP 5xx | 指數退避（base 2s，上限 60s） | `NVIDIA_MAX_RETRIES_5XX`（3） |
| 逾時 | 同 5xx | 同上 |
| `finish_reason: "length"` | 視為結構失敗，提高 `max_tokens` 後重試 | 1 |
| Schema／語意驗證失敗 | 附上錯誤說明要求重新生成 | `NVIDIA_MAX_SCHEMA_REGENERATIONS`（2） |
| 其他 4xx | **不重試**，直接失敗 | 0 |

### 任務優先級（BullMQ `priority`，數字越小越優先）

1. 使用者正在等待的單題分析
2. 使用者主動要求的多題分析
3. 題庫匯入後的背景分析
4. 維護與重新分析工作

---

## 6. 前端架構

- **App Router + Server Component 為預設**，需要互動或輪詢的頁面才標 `'use client'`。
- **TanStack Query** 管理伺服器狀態；AI 任務進度用 `refetchInterval`，達終態時回傳 `false` 停止輪詢。
- **React Hook Form + Zod resolver**，schema 直接來自 `@repo/contracts`，前後端驗證規則一致。
- **shadcn/ui + Tailwind**，元件複製進 repo，不隱藏在黑箱套件中。
- API 呼叫統一走 `src/lib/api-client.ts`：自動帶 Cookie、統一解析錯誤格式為 `ApiRequestError`。

### 環境變數的結構性隔離

`scripts/bootstrap-env.mjs` 產生 `apps/web/.env.local` 時**只寫入 `NEXT_PUBLIC_*`**。
因此後端機密（`NVIDIA_API_KEY`、`TAVILY_API_KEY`、`DATABASE_URL`、`REDIS_URL`、各種 secret）在檔案層級就不可能進入前端 bundle——不依賴開發者記得不要引用。

---

## 7. 錯誤處理

所有非 2xx 回應統一為：

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "請求內容未通過驗證。",
    "details": [{ "path": "questions.0.options", "message": "至少需要兩個選項" }],
    "requestId": "d34d46fc-5494-4c4b-9291-9fed6e022936",
    "timestamp": "2026-07-30T14:30:54.906Z"
  }
}
```

- `AllExceptionsFilter` 是唯一產生錯誤回應的地方。
- 5xx **一律回傳固定訊息**，完整堆疊只寫伺服器 log，避免洩漏內部細節（連線字串、外部 API 原始回應）。
- `requestId` 由 `RequestIdMiddleware` 產生並回寫 `X-Request-Id` 標頭，使用者回報問題時可直接對應 log。
- 錯誤碼與 HTTP 狀態的映射集中在 `@repo/contracts/errors.ts`，前端只需認 `code`。

---

## 8. 開發環境

| 元件 | 來源 | 說明 |
|---|---|---|
| PostgreSQL | **使用者既有的本機服務** | 依規格不在 Compose 重建；只用 `DATABASE_URL` |
| Redis | Docker Compose | 自動產生密碼；named volume；只綁 127.0.0.1 |
| Node | 22.x | |
| pnpm | 10.x | workspace |

### 非 ASCII 路徑的實際影響

專案路徑為 `d:\階段資料\個人資料\專案\題庫分析`，規劃時已預見風險，實測也確實踩到一個：

> Docker Compose 預設以目錄名稱推導 project name，而「題庫分析」經正規化後變成空字串，導致 `project name must not be empty`。

處理：`docker-compose.yml` 明確指定 `name: qba`。同時全面避免 bind mount（改用 named volume），腳本路徑一律加引號。

### 本機沒有 psql

所有資料庫操作都走 Node：Drizzle Kit 產生與套用 migration，`scripts/create-test-db.mjs` 以 node-postgres 建立測試資料庫。不依賴任何外部 CLI。
