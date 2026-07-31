# 題庫分析系統

選擇題題庫、作答、對答案與 **AI 錯題分析**系統。單一使用者的個人工具。

- 從 PDF 整理題庫（由外部 LLM 轉成 JSON，經驗證後匯入）
- 單選／複選作答，支援即答與交卷後對答案
- 錯題自動追蹤，含可解釋的熟練狀態
- AI 三階段深度解析（含網路查證與來源引用）
- 多題整合的弱點診斷

> **目前狀態：Phase 1 已完成**——可建立帳號、管理題庫階層、手動建題，
> 並以外部 AI 整理的 JSON 匯入整份題庫（含逐題驗證與預覽修正）。
> 作答與錯題系統屬 Phase 2。詳見 [實作計畫](./docs/IMPLEMENTATION_PLAN.md)。

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

# 3. 啟動 Redis
pnpm redis:up

# 4. 啟動後端與前端
pnpm dev
```

打開 <http://localhost:3000>。

| 服務 | 位址 |
|---|---|
| 前端 | <http://localhost:3000> |
| API | <http://localhost:4000/api/v1> |
| Swagger | <http://localhost:4000/docs> |
| 健康檢查 | <http://localhost:4000/api/v1/health/deps> |

### 首次使用

首次啟動前需先建立資料表：

```bash
pnpm --filter @repo/db db:migrate
```

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

# API 端到端驗證（需先啟動後端；預設打 :4000，可用 BASE 覆寫）
pnpm test:api-e2e
BASE=http://localhost:4101/api/v1 pnpm test:api-e2e

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
