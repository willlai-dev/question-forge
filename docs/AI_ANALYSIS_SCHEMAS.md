# AI 輸入輸出 Schema（AI_ANALYSIS_SCHEMAS）

> 版本：0.1.0（Phase 0 設計；Zod 實作於 `packages/contracts/src/ai/` — Phase 4）

---

## 0. 驗證架構

規劃階段的實測發現決定了這裡的設計：**NVIDIA 的 `response_format: json_schema` + `strict: true` 會在伺服器端強制結構正確，但不保證語意正確。**

實測案例：`reasoning_effort: "none"` 時模型輸出 `{"needsExternalSearch": true, "researchMode": "MODEL_ONLY", ...}` —— 完全符合 schema，但語意自相矛盾（說需要外部搜尋，卻選了不搜尋的模式）。

因此採四層驗證：

```
① NVIDIA json_schema (strict)   結構由 API 保證
② Zod schema 驗證                型別與範圍再確認（防 provider 行為改變）
③ Zod superRefine 語意驗證       跨欄位一致性 ← 實測證明必要
④ 參照完整性檢查                 sourceId / tagId 必須真實存在
                ↓
          全部通過才寫入資料庫
```

任一層失敗 → 附上錯誤說明要求重新生成，上限 `NVIDIA_MAX_SCHEMA_REGENERATIONS`（預設 2）。仍失敗則 job 標記 `failed`，原始輸出保存在 `raw_output` 供除錯。**絕不無限重試。**

### 共用型別

```ts
const ConfidenceSchema = z.number().min(0).max(1);

const ResearchModeSchema = z.enum(['MODEL_ONLY', 'PDF_KNOWLEDGE', 'WEB_RESEARCH', 'HYBRID']);

const OptionKeySchema = z.string().regex(/^[A-Z]$/);

const CitationSchema = z.object({
  sourceId: z.string(),            // 必須存在於本次證據集合
  quote: z.string().max(500).optional(),
  relevance: z.enum(['direct', 'supporting', 'background']),
});
```

---

## 1. 第一次 AI：研究規劃（`research_plan`）

### 輸入（由程式組裝，非模型自由取得）

| 欄位 | 來源 |
|---|---|
| `question.stem`、`question.type` | `questions` |
| `question.options[]` | `question_options`（含 key 與 text，**不含 is_correct 以外的內部欄位**） |
| `question.correctAnswers` | `question_options.is_correct` |
| `question.existingExplanation` | `questions.explanation`（可為 null） |
| `context.subject / chapter / questionGroup` | 階層名稱 |
| `context.availableKnowledgeTags[]` | 目前 active 的知識點名稱清單 |
| `context.sourceReference / sourcePage` | 題庫來源資訊 |

### 輸出 Schema

```ts
const ResearchPlanSchema = z.object({
  needsExternalSearch: z.boolean(),
  researchMode: ResearchModeSchema,
  reason: z.string().min(1).max(1000),
  queries: z.array(z.string().min(1).max(200)).max(3),      // 規格：每題最多 3 組
  preferredDomains: z.array(z.string()).max(10),
  preferredSourceTypes: z.array(
    z.enum(['official', 'academic', 'educational', 'reference', 'news', 'other'])
  ).max(6),
  freshnessRequired: z.boolean(),
  keyClaimsToVerify: z.array(z.string().min(1).max(300)).max(5),
});
```

### 語意驗證（superRefine）

| 規則 | 理由 |
|---|---|
| `needsExternalSearch === true` → `researchMode ≠ 'MODEL_ONLY'` | **實測踩過的矛盾** |
| `needsExternalSearch === false` → `researchMode === 'MODEL_ONLY'` 或 `'PDF_KNOWLEDGE'` | 不搜尋卻選 WEB_RESEARCH 無意義 |
| `researchMode ∈ {'WEB_RESEARCH','HYBRID'}` → `queries.length >= 1` | 要查卻沒給關鍵字 |
| `researchMode === 'MODEL_ONLY'` → `queries.length === 0` | 不查卻給關鍵字 |
| `needsExternalSearch === true` → `keyClaimsToVerify.length >= 1` | 要查總得有查證目標 |

參數：`reasoning_effort = low`、`max_tokens = 1500`、`temperature = 0.2`

---

## 2. 程式階段：搜尋與擷取（無 AI）

不是模型步驟，但它決定了下一階段的輸入品質，故一併定義。

```ts
interface EvidenceSource {
  sourceId: string;        // 'S1', 'S2', ... 由程式指派，模型只能引用這些
  url: string;
  domain: string;
  title: string;
  publishedDate: string | null;
  fetchedAt: string;
  trustTier: 'official' | 'academic' | 'educational' | 'reference' | 'other';
  content: string;         // 已截斷至 EVIDENCE_SOURCE_MAX_CHARS
  searchQuery: string;
  rank: number;
  score: number;
}
```

程式負責（規格 §9「程式搜尋與擷取」逐條）：

1. 執行 Tavily `/search`，每 query 限制 `TAVILY_MAX_RESULTS_PER_QUERY` 筆。
2. 跨 query 的 URL 去重（以正規化後的 URL 比對）。
3. 依 `trustTier` 排序：official > academic > educational > reference > other。
4. Tavily `/extract` 取正文（已是乾淨 markdown，不含 HTML/script/廣告/導覽）。
5. 單一來源截斷至 `EVIDENCE_SOURCE_MAX_CHARS`（4000），總量上限 `EVIDENCE_TOTAL_MAX_CHARS`（24000）。
6. 過濾內容過短（< 200 字元）或擷取失敗的頁面。
7. 保存標題、URL、網域、日期、擷取時間至 `question_evidence_sources`。
8. 快取：Redis（TTL）+ `web_documents`（跨題重用）。
9. **Prompt Injection 防護**：正文包在分隔標記內，前置不可信聲明。

`trustTier` 判定以網域規則為主（`.gov`、`.edu`、`.org` 學術機構、已知法規資料庫等），無法判定則為 `other`。

---

## 3. 第二次 AI：證據整理（`evidence_synthesis`）

### 輸入

題目與選項、題庫答案、題庫原解析、第一次 AI 的研究計畫、上一階段的 `EvidenceSource[]`。

### 輸出 Schema

```ts
const EvidenceSynthesisSchema = z.object({
  evidenceSummary: z.string().min(1).max(3000),
  supportedClaims: z.array(z.object({
    claim: z.string().min(1).max(500),
    sourceIds: z.array(z.string()).min(1),
    strength: z.enum(['strong', 'moderate', 'weak']),
  })).max(10),
  contradictedClaims: z.array(z.object({
    claim: z.string().min(1).max(500),
    sourceIds: z.array(z.string()).min(1),
    explanation: z.string().max(1000),
  })).max(10),
  conflicts: z.array(z.object({
    description: z.string().min(1).max(1000),
    conflictingSourceIds: z.array(z.string()).min(2),
  })).max(5),
  insufficientEvidence: z.boolean(),
  recommendedAnswer: z.array(OptionKeySchema),
  confidence: ConfidenceSchema,
  requiresHumanReview: z.boolean(),
});
```

### 語意驗證

| 規則 | 理由 |
|---|---|
| 所有 `sourceIds` ⊆ 本次證據集合的 `sourceId` | **AI 不得產生不存在的來源**（規格 §9 明文） |
| `insufficientEvidence === true` → `confidence <= 0.5` | 證據不足卻高信心是矛盾 |
| `insufficientEvidence === true` → `requiresHumanReview === true` | 證據不足必須人工看 |
| 題目為 `single_choice` → `recommendedAnswer.length <= 1` | 單選題不能推薦多個答案 |
| `recommendedAnswer` 中每個 key 必須存在於該題選項 | 不能推薦不存在的選項 |
| `conflicts[].conflictingSourceIds.length >= 2` | 「衝突」至少要有兩方 |

若 `sourceIds` 出現不存在的 ID：該筆證據**直接剔除**，並將 `requiresHumanReview` 強制設為 true，同時記一筆 `AI_CITATION_UNKNOWN_SOURCE` 到 log。

參數：`reasoning_effort = medium`、`max_tokens = 3000`、`temperature = 0.2`

---

## 4. 第三次 AI：最終解析（`final_explanation`）

### 輸入

| 欄位 | 說明 |
|---|---|
| 題目、所有選項 | |
| `userAnswers` | 使用者選的答案 |
| `storedCorrectAnswers` | 題庫標準答案 |
| `originalExplanation` | 題庫原解析（可為 null） |
| `evidence` | 第二次整理後的結果 + 來源清單 |
| `userHistory` | 該使用者在**相同知識點**的錯題統計 |
| `allowedKnowledgeTags[]` | 系統目前允許的知識點（**AI 只能從中選**） |
| `allowedSkillTags[]` | 允許的能力類型 |
| `allowedErrorTypes[]` | 允許的錯誤類型（含 fallback「無法判定」） |

### 輸出 Schema

```ts
const FinalExplanationSchema = z.object({
  answerValidation: z.object({
    agreesWithStoredAnswer: z.boolean(),
    verifiedAnswers: z.array(OptionKeySchema),
    conflictReason: z.string().max(1000).nullable(),
    confidence: ConfidenceSchema,
  }),

  explanation: z.object({
    coreConcept: z.string().min(1).max(1000),          // 核心概念
    solutionSteps: z.array(z.string().min(1).max(500)).min(1).max(8),  // 解題步驟
    summary: z.string().min(1).max(2000),
  }),

  optionAnalysis: z.array(z.object({                    // 每個選項對錯原因
    key: OptionKeySchema,
    isCorrect: z.boolean(),
    reason: z.string().min(1).max(1000),
  })).min(2),

  mistakeAnalysis: z.object({
    userWasCorrect: z.boolean(),
    whyUserMightBeWrong: z.string().max(1500).nullable(),  // 使用者為什麼可能選錯
    missedConditions: z.array(z.string().max(500)).max(5), // 忽略的條件
    errorTypeCode: z.string(),                             // 必須是既有錯誤類型
    primaryKnowledgeTag: z.string(),                       // 必須是既有知識點
    secondaryKnowledgeTags: z.array(z.string()).max(2),
    skillTag: z.string().nullable(),
    reviewSuggestions: z.array(z.string().max(500)).min(1).max(5), // 複習建議
    suggestedNewTags: z.array(z.object({                   // 只能「建議」，不能建立
      kind: z.enum(['knowledge', 'skill', 'error_type']),
      name: z.string().max(100),
      rationale: z.string().max(500),
    })).max(3),
  }),

  citations: z.array(CitationSchema).max(10),
  confidence: ConfidenceSchema,
  requiresHumanReview: z.boolean(),
});
```

### 語意驗證

| 規則 | 理由 |
|---|---|
| `optionAnalysis` 的 key 集合 = 該題所有選項 key（不多不少） | 不得漏解釋或憑空生選項 |
| `optionAnalysis` 中 `isCorrect = true` 的集合 = `answerValidation.verifiedAnswers` | 內部一致性 |
| `agreesWithStoredAnswer === false` → `conflictReason` 不為 null | 說答案錯了就得說為什麼 |
| `agreesWithStoredAnswer === false` → `requiresHumanReview === true` | 質疑題庫答案必須人工審 |
| `mistakeAnalysis.userWasCorrect === false` → `whyUserMightBeWrong` 不為 null | 答錯必須有錯因說明 |
| `userWasCorrect === true` → `errorTypeCode` 為 fallback「無法判定」 | 答對不該硬套錯誤類型 |
| `citations[].sourceId` ⊆ 本次證據集合 | **引用必須真實存在** |
| `errorTypeCode` ∈ `allowedErrorTypes` | AI 不得自創錯誤類型 |
| `primaryKnowledgeTag` ∈ `allowedKnowledgeTags`（經別名正規化後） | AI 不得自創知識點 |
| `secondaryKnowledgeTags` 全部 ∈ allowed，且不含 primary | 規格：次要最多 2 個 |
| `researchMode = MODEL_ONLY` → `citations` 必須為空 | 沒查資料就不能有引用 |

### 標籤處理流程

```
AI 回傳標籤名稱
      ↓
以 tag_aliases 正規化（去空白、轉小寫、全形轉半形）
      ↓
  對得上既有 tag？
   ├─ 是 → 寫入 question_knowledge_tags（source = 'ai'）
   └─ 否 → 丟棄該標籤，改寫入 tag_suggestions（status = 'pending'）
            並在結果上標示「知識點待補」
```

**AI 永遠不能建立正式標籤**（規格 §8、驗收標準 #12）。`suggestedNewTags` 一律進 `tag_suggestions` 等人工審核。

參數：`reasoning_effort = high`、`max_tokens = 4500`、`temperature = 0.2`

---

## 5. 多題整合分析（`aggregate_analysis`）

### 輸入：先統計，再送模型

規格 §11 明確要求「不應直接將所有完整題目一次傳給模型」。輸入分兩部分：

**(a) PostgreSQL 統計結果**（結構化數字，非題目原文）：

```ts
interface AggregateStats {
  period: { from: string; to: string };
  overall: { totalAnswered: number; accuracy: number; avgResponseTimeMs: number };
  bySubject: Array<{ id: string; name: string; answered: number; accuracy: number }>;
  byChapter: Array<{ id: string; name: string; answered: number; accuracy: number }>;
  byQuestionGroup: Array<{ id: string; name: string; answered: number; accuracy: number }>;
  byKnowledgeTag: Array<{ id: string; name: string; answered: number; accuracy: number; trend: number }>;
  byErrorType: Array<{ code: string; name: string; count: number }>;
  consecutiveWrongStreaks: Array<{ knowledgeTag: string; streak: number }>;
  recentAccuracyChange: { previous: number; current: number; delta: number };
  improved: string[];
  notImproved: string[];
}
```

**(b) 代表錯題**（依統計挑選，數量上限 15）：每題只送題幹摘要、使用者答案、正確答案、知識點、錯誤類型——不送完整選項與解析。

> 所有統計查詢一律加 `WHERE user_answers.is_provisional = false`，爭議題不進入診斷。

### 輸出 Schema

```ts
const AggregateAnalysisSchema = z.object({
  weakestKnowledgeTags: z.array(z.object({
    tagName: z.string(),
    accuracy: z.number().min(0).max(1),
    severity: z.enum(['critical', 'high', 'moderate']),
    evidence: z.string().max(500),
  })).max(8),

  commonErrorTypes: z.array(z.object({
    errorTypeCode: z.string(),
    count: z.number().int().nonnegative(),
    interpretation: z.string().max(500),
  })).max(8),

  errorPatterns: z.array(z.object({
    pattern: z.string().max(500),
    relatedKnowledgeTags: z.array(z.string()),
    relatedErrorTypes: z.array(z.string()),
    explanation: z.string().max(1000),
  })).max(5),

  reviewPriority: z.array(z.object({
    rank: z.number().int().positive(),
    target: z.string().max(200),
    reason: z.string().max(500),
  })).max(10),

  recommendedPractice: z.array(z.object({
    kind: z.enum(['question_group', 'question', 'knowledge_tag']),
    refId: z.string(),
    label: z.string().max(200),
    reason: z.string().max(500),
  })).max(10),

  improvement: z.object({
    hasImproved: z.boolean(),
    improvedAreas: z.array(z.string()).max(10),
    stagnantAreas: z.array(z.string()).max(10),
    summary: z.string().max(1500),
  }),

  learningSuggestions: z.array(z.string().max(800)).min(1).max(8),
  analysisBasis: z.string().min(1).max(2000),
  confidence: ConfidenceSchema,
});
```

### 語意驗證

| 規則 |
|---|
| `weakestKnowledgeTags[].tagName` 必須存在於輸入統計的知識點清單 |
| `commonErrorTypes[].errorTypeCode` 必須是既有錯誤類型 |
| `recommendedPractice[].refId` 必須存在於輸入的代表錯題或題組清單 |
| `reviewPriority[].rank` 不重複且連續 |
| `improvement.hasImproved === true` → `improvedAreas.length >= 1` |

參數：`reasoning_effort = high`、`max_tokens = 4500`

---

## 6. 送給 NVIDIA 的 JSON Schema 形式

Zod schema 會轉成 API 接受的格式。實測確認以下形式有效：

```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "research_plan",
      "strict": true,
      "schema": { "type": "object", "properties": { }, "required": [ ], "additionalProperties": false }
    }
  }
}
```

注意事項（皆為實測結論）：

- `strict: true` 時 `additionalProperties: false` 為必要。
- **未知的頂層參數會被硬性 400 拒絕**，Provider 只能送白名單參數。
- `reasoning_effort` 是合法參數，值域 `none|minimal|low|medium|high|xhigh|max`。
- `reasoning_effort` 非 `none` 時，回應含 `reasoning_content` 欄位，其 token 計入 `completion_tokens` ——
  故 `max_tokens` 必須留足空間，否則會 `finish_reason: "length"` 導致 JSON 截斷。
- 回應的 `usage` 提供 `prompt_tokens` / `completion_tokens` / `total_tokens`，直接寫入 `ai_usage_logs`。
