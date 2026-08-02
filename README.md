# 題庫分析系統

選擇題題庫、作答、對答案與 **AI 錯題分析**系統。單一使用者的個人工具。

- 從 PDF 整理題庫（由外部 LLM 轉成 JSON，經驗證後匯入）
- 單選／複選作答，支援即答與交卷後對答案
- 錯題自動追蹤，含可解釋的熟練狀態
- AI 三階段深度解析（含網路查證與來源引用）
- 多題整合的弱點診斷

> **目前狀態：Phase 4 已完成**——可建立帳號、管理題庫階層、匯入題庫、**實際刷題**
> （程式判分、錯題本、熟練狀態）、**用受控標籤組織題庫**，並且可以對錯題按下
> **AI 深度解析**：三階段查證（規劃 → 搜尋外部資料 → 產生解析），
> 每個選項為何對錯、你可能為什麼選錯、附上實際查到的來源連結。
> AI 認為題庫答案有誤時會建立待審爭議，**絕不自行修改答案**。
> 剩下 Phase 5（多題整合的弱點診斷）。詳見 [實作計畫](./docs/IMPLEMENTATION_PLAN.md)。

### 主要頁面

| 路徑 | 用途 |
|---|---|
| `/dashboard` | 學習概況：作答數、正確率、錯題分布、近期場次 |
| `/quiz/new` | 選出題範圍與作答方式，開始作答 |
| `/quiz` | 作答場次歷史；未交卷的可回去接著作答 |
| `/mistakes` | 錯題本，可依科目、知識點、錯誤類型與熟練狀態篩選並一鍵重練 |
| `/tags` | 標籤管理：知識點、能力類型、錯誤類型、別名 |
| `/tags/suggestions` | 標籤建議審核（AI 只能建議，不能自己建立標籤） |
| `/conflicts` | 答案爭議裁決（AI 質疑題庫答案時出現） |
| `/ai/jobs`、`/ai/usage` | AI 任務進度與用量統計 |
| `/subjects`、`/question-groups`、`/questions` | 題庫維護 |
| `/imports` | JSON 匯入（含逐題驗證與預覽修正） |

---

## 快速開始

### 你只需要準備三件事

| 項目 | 說明 |
|---|---|
| **Node.js 22+** 與 **pnpm 10+** | |
| **Docker Desktop** | 只用來跑 Redis |
| **本機 PostgreSQL** | 已有的即可，系統不會另外建立 |

### 你只需要手動填三個環境變數

```bash
# 1. 複製環境變數範本
cp .env.example .env
```

編輯 `.env`，只填這三個：

```env
NVIDIA_API_KEY=你的 NVIDIA NIM 金鑰
TAVILY_API_KEY=你的 Tavily 金鑰
DATABASE_URL=postgresql://使用者:密碼@localhost:5432/資料庫名稱
```

**其餘全部由系統自動產生**——JWT secret、Cookie secret、CSRF secret、Redis 密碼與連線字串，
以及所有非機密的預設值（模型名稱、限流參數、快取時間、佇列設定…）。

### 啟動

```bash
# 2. 安裝相依套件（安裝後會自動補齊 .env 中的其餘變數）
pnpm install

# 3. 建立資料表（第一次啟動前必做；之後有新的 migration 時再跑）
pnpm --filter @repo/db db:migrate

# 4. 啟動 Redis
pnpm redis:up

# 5. 啟動後端與前端
pnpm dev
```

> 順序不可對調：後端啟動時會連線資料庫並寫入種子資料（能力類型、錯誤類型、
> prompt 版本），資料表不存在就會啟動失敗。

打開 <http://localhost:3000>。

| 服務 | 位址 |
|---|---|
| 前端 | <http://localhost:3000> |
| API | <http://localhost:4000/api/v1> |
| Swagger | <http://localhost:4000/docs> |
| 健康檢查 | <http://localhost:4000/api/v1/health/deps> |

### 首次使用

系統第一次啟動時沒有任何帳號。開啟 <http://localhost:3000> 會自動導向 `/setup` 建立你的帳號
（密碼至少 8 字元，且不得與帳號相同；輸入框右側有顯示／隱藏切換）。
**建立完成後該頁面永久停用**，不需要也不應該把帳號密碼寫進 `.env`。

---

## 常用指令

```bash
# 開發
pnpm dev                 # 前後端一起啟動
pnpm dev:api             # 只啟動後端
pnpm dev:web             # 只啟動前端

# Redis
pnpm redis:up            # 啟動
pnpm redis:down          # 停止
pnpm redis:logs          # 看日誌

# 品質檢查
pnpm verify              # typecheck + lint + test + build（每個 Phase 完成必跑）
pnpm typecheck
pnpm lint
pnpm test                # 單元測試
pnpm build

# API 端到端驗證
# 這些腳本會實際建立科目、題目與作答紀錄，因此預設打「測試後端」:4101，
# 不會碰到 pnpm dev 的 :4000。要改目標請自行設 BASE。
#
# 完整流程（四步都不能少，且順序不可對調）：
#   1) 重置測試資料庫
#      node scripts/create-test-db.mjs --drop
#   2) 套用 migration（新建的資料庫是空的，少了這步後端起不來）
#      DATABASE_URL=<把資料庫名稱換成 <db>_test> pnpm --filter @repo/db db:migrate
#   3) 以 Mock provider 啟動測試後端
#      （不用 Mock 會消耗真實 AI 額度，且結果不可重現）
#      DATABASE_URL=<同上> PORT=4101 AI_PROVIDER=mock SEARCH_PROVIDER=mock \
#        node apps/api/dist/main.js
#   4) 跑測試
pnpm test:api-e2e
#
# 為什麼 2、3 不能對調：種子資料（能力類型、錯誤類型、prompt 版本）是後端
# 啟動時寫入的。先起後端再重置資料庫，種子就會消失，Phase 3 之後會整批失敗。
#
# Windows PowerShell 沒有 `VAR=值 指令` 這種寫法，請改用：
#   $env:DATABASE_URL="..."; $env:PORT="4101"; node apps/api/dist/main.js

# 環境變數
pnpm bootstrap:env       # 補齊缺少的變數（可重複執行，不會覆寫既有值）
node scripts/bootstrap-env.mjs --check   # 只檢查三個必要變數是否存在

# 資料庫（Phase 1 起）
pnpm --filter @repo/db db:generate       # 由 schema 產生 migration
pnpm --filter @repo/db db:migrate        # 套用 migration
pnpm --filter @repo/db db:studio         # Drizzle Studio
pnpm db:test:create                      # 建立整合測試用的資料庫
```

---

## 專案結構

```
apps/
  api/            NestJS 後端（REST + Swagger + BullMQ worker）
  web/            Next.js 前端（App Router + Tailwind + shadcn/ui）
packages/
  contracts/      前後端共用的 Zod 契約（環境變數、錯誤格式、API DTO、AI schema）
  db/             Drizzle schema、migration、連線
docs/             設計文件
scripts/          環境變數啟動器、測試資料庫建立
```

---

## 設計文件

| 文件 | 內容 |
|---|---|
| [SYSTEM_DESIGN](./docs/SYSTEM_DESIGN.md) | 總覽、關鍵決策、風險 |
| [FUNCTIONAL_REQUIREMENTS](./docs/FUNCTIONAL_REQUIREMENTS.md) | 功能規格與驗收標準對照 |
| [ARCHITECTURE](./docs/ARCHITECTURE.md) | 架構、模組、資料流、AI 層抽象 |
| [ERD](./docs/ERD.md) | 資料模型與關鍵約束 |
| [API_CONTRACT](./docs/API_CONTRACT.md) | REST API 與統一錯誤格式 |
| [QUESTION_IMPORT_SCHEMA.json](./docs/QUESTION_IMPORT_SCHEMA.json) | 匯入 JSON Schema |
| [QUESTION_IMPORT_PROMPT](./docs/QUESTION_IMPORT_PROMPT.md) | **給外部 LLM 整理 PDF 用的 Prompt** |
| [AI_ANALYSIS_SCHEMAS](./docs/AI_ANALYSIS_SCHEMAS.md) | AI 三階段輸入輸出 Schema |
| [AI_PROMPTS](./docs/AI_PROMPTS.md) | Prompt 設計與版本規則 |
| [SECURITY](./docs/SECURITY.md) | 安全設計 |
| [TEST_PLAN](./docs/TEST_PLAN.md) | 測試計畫 |
| [IMPLEMENTATION_PLAN](./docs/IMPLEMENTATION_PLAN.md) | Phase 0～5 里程碑 |

---

## 技術堆疊

| 層 | 技術 |
|---|---|
| 前端 | Next.js（App Router）、TypeScript、Tailwind CSS、shadcn/ui、TanStack Query、React Hook Form、Zod |
| 後端 | NestJS、TypeScript、REST、Swagger／OpenAPI、Zod |
| 資料庫 | PostgreSQL、Drizzle ORM、Drizzle Kit migration |
| 背景工作 | Redis、BullMQ |
| AI | NVIDIA NIM（`nvidia/nemotron-3-ultra-550b-a55b`） |
| 搜尋 | Tavily（search + extract） |

---

## 疑難排解

### 改了程式碼、也重啟了，行為卻完全沒變（Windows 常見）

在 Windows 上對 `pnpm dev` 按 Ctrl+C 時，`pnpm → nest → node` 的孫行程常常不會跟著結束。
舊的後端會繼續佔用 4000，新啟動的後端搶不到埠而失敗 —— 於是你的請求其實一直打到那個舊行程。

```bash
pnpm dev:ports        # 看看 3000 / 4000 被誰佔用、何時啟動的
pnpm dev:ports:kill   # 終止它們，然後重新 pnpm dev
```

判斷依據：如果佔用行程的「啟動時間」早於你最後一次改動，那就是它。

### 改了 `packages/contracts` 但行為沒變（例如驗證規則還是舊的）

`apps/api` 引用的是 `packages/contracts` **建置後的 dist**，而 `nest start --watch`
只監看 `apps/api/src`。因此執行中的後端進程會一直用著啟動當下載入記憶體的舊版契約，
即使原始碼與 dist 都已更新。

症狀：改了驗證規則，API 卻仍回舊的錯誤訊息。

**確定有效的做法：重啟 `pnpm dev`**（Ctrl+C 後重跑）。

判斷是不是這個問題：比對「原始碼」與「執行中的 API 實際回應」——

```bash
grep -n "PASSWORD_MIN_LENGTH" packages/contracts/src/api/auth.ts   # 原始碼
curl -s http://localhost:4000/api/v1/auth/bootstrap                # 執行中的 API
```

### `pnpm dev` 說找不到 `@repo/contracts`

共用套件需要先建置：

```bash
pnpm build:packages
```

（`pnpm dev` 已包含此步驟，單獨執行 `pnpm --filter @repo/api dev` 時才需要手動跑。）

### Redis 起不來，出現 `project name must not be empty`

本專案目錄名稱是中文，Docker Compose 無法從中推導出合法的 project name。
`docker-compose.yml` 已明確指定 `name: qba` 解決此問題。若仍出現此錯誤，請確認你使用的是本 repo 的 compose 檔。

### Redis 起不來，出現 `REDIS_PASSWORD 未設定`

先執行 `pnpm bootstrap:env` 產生密碼，再 `pnpm redis:up`。

### API 啟動時說環境變數有誤

錯誤訊息會明確指出是哪一個變數（只給鍵名，不會印出內容）。
若缺的是自動產生的變數，執行 `pnpm bootstrap:env`；
若缺的是三個必要變數之一，請自行填入 `.env`。

### `/health/deps` 顯示 postgres down

確認 `DATABASE_URL` 指向的 PostgreSQL 正在執行、資料庫已存在、帳號密碼正確。
本專案**不會**自動建立主資料庫（依規格，PostgreSQL 由你自行管理）。

### 拉取 Redis 映像檔失敗

Docker Hub 的 CDN 偶發性連線中斷，重試通常即可：

```bash
docker pull redis:7-alpine
```

---

## 安全須知

- `.env` 已列入 `.gitignore`，**請勿提交**。
- 前端只會取得 `NEXT_PUBLIC_*` 變數；`apps/web/.env.local` 由腳本自動產生且只含公開變數。
- API 金鑰只存在後端，不會出現在任何前端 bundle 或 API 回應中。
- 詳見 [SECURITY.md](./docs/SECURITY.md)。
