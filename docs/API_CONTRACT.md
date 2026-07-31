# API 契約（API_CONTRACT）

> 版本：0.1.0（Phase 0）
> 執行中的機器可讀版本：`http://localhost:4000/docs`（Swagger / OpenAPI）

---

## 1. 通則

| 項目 | 值 |
|---|---|
| Base URL | `http://localhost:4000/api/v1` |
| 內容型別 | `application/json`（匯入上傳為 `multipart/form-data`） |
| 認證 | HttpOnly Cookie（`access_token` / `refresh_token`） |
| CSRF | 狀態變更請求需帶 `X-CSRF-Token` 標頭 |
| 追蹤 | 每個回應都有 `X-Request-Id` |

### 分頁

列表端點統一使用 `?page=1&pageSize=20&sort=field:asc`，回應格式：

```json
{
  "items": [],
  "pagination": { "page": 1, "pageSize": 20, "total": 137, "totalPages": 7 }
}
```

### 統一錯誤格式

所有非 2xx 一律為：

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "請求內容未通過驗證。",
    "details": [{ "path": "questions.0.options", "message": "至少需要兩個選項", "code": "TOO_FEW_OPTIONS" }],
    "requestId": "d34d46fc-5494-4c4b-9291-9fed6e022936",
    "timestamp": "2026-07-30T14:30:54.906Z"
  }
}
```

錯誤碼與 HTTP 狀態的對應表定義於 `packages/contracts/src/errors.ts`（`ERROR_STATUS_MAP`），前端只需認 `code`。

> **5xx 一律回傳固定訊息**，不含內部細節。完整堆疊只寫伺服器 log，以 `requestId` 對應。

---

## 2. 認證

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/auth/bootstrap` | 查詢是否仍可初始化。回 `{ "canBootstrap": true }` |
| `POST` | `/auth/bootstrap` | 建立唯一帳號。**已完成後永久回 `410 SETUP_ALREADY_COMPLETED`** |
| `POST` | `/auth/login` | 帳密登入，設定 HttpOnly Cookie |
| `POST` | `/auth/refresh` | 輪替 refresh token |
| `POST` | `/auth/logout` | 清除 Cookie 並撤銷 token |
| `GET` | `/auth/me` | 目前使用者 |
| `GET` | `/auth/csrf` | 取得 CSRF token（同時設定非 HttpOnly 的 `csrf_token` Cookie） |

`POST /auth/bootstrap` 請求：
```json
{ "username": "owner", "password": "至少12字元", "displayName": "我" }
```

錯誤：`SETUP_ALREADY_COMPLETED`(410)、`VALIDATION_FAILED`(400)、`INVALID_CREDENTIALS`(401)

---

## 3. 題庫階層

### 科目
| 方法 | 路徑 |
|---|---|
| `GET` | `/subjects` |
| `POST` | `/subjects` |
| `GET` `PATCH` `DELETE` | `/subjects/:id` |
| `POST` | `/subjects/reorder` — body `{ "orderedIds": ["...", "..."] }` |

### 章節
| 方法 | 路徑 |
|---|---|
| `GET` | `/subjects/:subjectId/chapters` |
| `POST` | `/chapters` |
| `GET` `PATCH` `DELETE` | `/chapters/:id` |
| `POST` | `/chapters/reorder` |

### 題組
| 方法 | 路徑 |
|---|---|
| `GET` | `/question-groups?subjectId=&chapterId=&q=&page=&pageSize=` |
| `POST` | `/question-groups` — `{ subjectId, chapterId?, name, description?, source?, year?, notes? }` |
| `GET` `PATCH` `DELETE` | `/question-groups/:id` |
| `POST` | `/question-groups/reorder` |

> `chapterId` 若不屬於 `subjectId`，回 `409 CHAPTER_SUBJECT_MISMATCH`（由資料庫複合外鍵攔下）。

---

## 4. 題目

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/questions` | 篩選：`q`、`subjectId`、`chapterId`、`questionGroupId`、`type`、`knowledgeTagIds`、`errorTypeIds`、`reviewRequired`、`status`、`hasExplanation`、`page`、`pageSize`、`sort` |
| `POST` | `/questions` | 建立 |
| `GET` `PATCH` `DELETE` | `/questions/:id` | |
| `POST` | `/questions/bulk` | 批次操作 |
| `GET` | `/questions/:id/versions` | 版本歷史 |

`POST /questions` 請求：

```json
{
  "questionGroupId": "uuid",
  "questionNumber": 12,
  "type": "single_choice",
  "stem": "下列何者屬於行政處分？",
  "options": [
    { "key": "A", "text": "行政指導", "isCorrect": false },
    { "key": "B", "text": "違章建築拆除命令", "isCorrect": true },
    { "key": "C", "text": "行政計畫", "isCorrect": false },
    { "key": "D", "text": "行政契約", "isCorrect": false }
  ],
  "explanation": null,
  "sourcePage": 42,
  "sourceReference": "第三章 行政行為",
  "reviewRequired": false
}
```

`POST /questions/bulk` 請求：
```json
{
  "questionIds": ["uuid", "uuid"],
  "action": "move",
  "payload": { "targetQuestionGroupId": "uuid" }
}
```
`action` 可為 `move`／`delete`／`addTags`／`removeTags`／`setReviewRequired`。

驗證規則（違反回 `400 VALIDATION_FAILED`）：
- `stem` 不可為空白
- 至少 2 個選項
- 選項 `key` 不重複
- `single_choice` 恰 1 個 `isCorrect`；`multiple_choice` 至少 2 個
- `explanation` 可為 `null`，但不得由系統自動填入內容

---

## 5. 匯入

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/imports/schema` | 回傳 JSON Schema 本體 |
| `GET` | `/imports/prompt` | 回傳給外部 LLM 的固定 Prompt 文字 |
| `POST` | `/imports` | `multipart/form-data`，欄位 `file`。大小上限 `IMPORT_MAX_FILE_SIZE_BYTES` |
| `GET` | `/imports` | 批次列表 |
| `GET` | `/imports/:id` | 批次摘要與統計 |
| `GET` | `/imports/:id/questions` | `?status=error\|warning\|valid\|excluded&page=` |
| `PATCH` | `/imports/:id/questions/:importQuestionId` | 修正暫存題目 |
| `POST` | `/imports/:id/questions/:importQuestionId/exclude` | 排除該題 |
| `POST` | `/imports/:id/revalidate` | 重新驗證整批 |
| `POST` | `/imports/:id/commit` | **確認寫入正式題庫** |
| `DELETE` | `/imports/:id` | 丟棄批次 |

### 匯入流程狀態機

```
uploaded → validating → validated ─────┐
                     ↘ partially_valid ┤→ committing → committed
                     ↘ failed          │
                                       └→ discarded
```

`POST /imports/:id/commit` 只在沒有阻斷性錯誤（level = `error` 且未被排除）時才成功，否則回 `400 IMPORT_HAS_BLOCKING_ERRORS`，並在 `details` 列出仍待處理的題目。

### 5. 匯入驗證規則與錯誤碼

| 代碼 | 等級 | 規則 | 規格出處 |
|---|---|---|---|
| `UNSUPPORTED_SCHEMA_VERSION` | error | `schemaVersion` 不在支援清單 | §5 |
| `INVALID_QUESTION_TYPE` | error | 題型不是 `single_choice` / `multiple_choice` | §5 |
| `EMPTY_STEM` | error | 題幹為空或只有空白 | §5 |
| `TOO_FEW_OPTIONS` | error | 選項少於 2 個 | §5 |
| `DUPLICATE_OPTION_KEY` | error | 同題選項 key 重複 | §5 |
| `CORRECT_ANSWER_NOT_IN_OPTIONS` | error | 正確答案不存在於選項 key 中 | §5 |
| `SINGLE_CHOICE_MULTIPLE_ANSWERS` | error | 單選題有多於 1 個正確答案 | §5 |
| `MULTIPLE_CHOICE_TOO_FEW_ANSWERS` | error | 複選題正確答案少於 2 個 | §5 |
| `DUPLICATE_EXTERNAL_ID_IN_BATCH` | error | 同批次內 `externalId` 重複 | §5 |
| `DUPLICATE_EXTERNAL_ID_IN_DB` | error | 與既有題庫的 `externalId` 衝突 | §5 |
| `DUPLICATE_QUESTION_NUMBER` | error | 同題組題號重複 | §5 |
| `INVALID_SOURCE_PAGE` | error | `sourcePage` 非正整數 | §5 |
| `MISSING_EXPLANATION` | **warning** | `explanation` 為 null。**只標示，絕不自動編造** | §5 |
| `REVIEW_REQUIRED` | **warning** | `reviewRequired = true`，預覽介面須醒目顯示 | §5 |
| `OPTION_KEY_NOT_UPPERCASE` | warning | 選項 key 非大寫英文字母 | §5 |
| `STEM_TOO_LONG` | warning | 題幹超過建議長度，可能是跨頁未正確合併 | 實務補充 |
| `TOO_MANY_QUESTIONS` | error | 題數超過 `IMPORT_MAX_QUESTIONS` | 實務補充 |

**warning 不阻擋 commit，error 阻擋。** 使用者可修正或排除有 error 的題目後再 commit。

---

## 6. 作答

| 方法 | 路徑 | 說明 |
|---|---|---|
| `POST` | `/quiz-sessions` | 建立場次 |
| `GET` | `/quiz-sessions` | 歷史列表 |
| `GET` | `/quiz-sessions/:id` | 場次狀態與進度 |
| `GET` | `/quiz-sessions/:id/questions/:position` | 取單題（**選項已依 `option_order` 排好**） |
| `POST` | `/quiz-sessions/:id/answers` | 作答 |
| `PATCH` | `/quiz-sessions/:id/answers/:answerId` | 修改答案 |
| `POST` | `/quiz-sessions/:id/submit` | 交卷 |
| `GET` | `/quiz-sessions/:id/result` | 結果 |
| `POST` | `/quiz-sessions/:id/abandon` | 放棄 |

`POST /quiz-sessions` 請求：

```json
{
  "mode": "practice",
  "scopes": [{ "scopeType": "question_group", "refId": "uuid" }],
  "orderStrategy": "random",
  "shuffleOptions": true,
  "questionLimit": 20,
  "revealMode": "after_submit",
  "allowAnswerChange": true,
  "onlyMistakes": false,
  "masteryStates": []
}
```

- `scopeType` 目前接受 `subject` / `chapter` / `question_group`，多個範圍之間取**聯集**。
- `onlyMistakes` 與範圍取**交集**；`masteryStates` 只能搭配 `onlyMistakes` 使用。
- 範圍內沒有可作答的題目 → `422 QUIZ_NO_QUESTIONS_MATCHED`；範圍 ID 不存在 → `404`。
- 沒有給任何範圍且未勾選 `onlyMistakes` → `400 VALIDATION_FAILED`。

> `knowledgeTagIds`（只作答特定知識點，FR-QUIZ-06）屬 Phase 3。
> 資料庫的 `quiz_session_scopes.scope_type` CHECK 已預留 `knowledge_tag`，屆時只需開放 API。

### 答案揭露規則（重要）

**整份作答契約中，正確答案只會出現在單一個可為 null 的 `reveal` 物件裡：**

```json
"reveal": { "isCorrect": true, "correctAnswers": ["B"], "explanation": "…" }
```

不揭露時 `reveal` 為 `null`。之所以收斂成一個欄位而不是把 `isCorrect`、`correctAnswers`、
`explanation` 平鋪在回應各處，是因為後者每新增一個欄位就多一條可能的洩漏管道，而且很難測；
收斂之後「答案只有一個出口」在契約層一眼可見，測試也只需斷言 `reveal === null`。

| `revealMode` | 交卷前 | 交卷後 |
|---|---|---|
| `immediate` | 未作答 → `null`；**作答後**才揭露 | 揭露 |
| `after_submit` | **一律 `null`** | 揭露 |

同樣的理由，`GET /quiz-sessions/:id` 的 `correctCount` 在 `after_submit` 模式交卷前為 `null` ——
那個數字本身就足以反推剛才那題答對沒有。

> 這是契約層的硬性保證，不是前端隱藏。`after_submit` 模式下若在交卷前請求結果，回
> `409 QUIZ_ANSWER_NOT_REVEALED_YET`。端到端測試對整份回應做**遞迴掃描**，
> 只要出現任何非 null 的答案類欄位就失敗 —— 逐欄位列舉會隨著契約演進而失效。

`POST /quiz-sessions/:id/answers` 請求與回應：

```json
// 請求
{ "sessionQuestionId": "uuid", "selectedAnswers": ["B"], "responseTimeMs": 8421 }

// 回應（revealMode = immediate）
{
  "answerId": "uuid",
  "recorded": true,
  "answeredCount": 3,
  "totalQuestions": 20,
  "reveal": { "isCorrect": true, "correctAnswers": ["B"], "explanation": null }
}

// 回應（revealMode = after_submit）
{ "answerId": "uuid", "recorded": true, "answeredCount": 3, "totalQuestions": 20, "reveal": null }
```

判分由程式完成（`gradeAnswer()` 純函式），**不呼叫任何 AI**。
複選題必須完全一致才給分，順序無關，部分正確與多選皆不給分。

**修改答案**：對已作答的題目再次 `POST` 等同於 `PATCH`，兩者都套用同一套規則 ——
前端不必判斷該用哪個動詞。`allowAnswerChange = false` 時兩者皆回
`409 QUIZ_ANSWER_CHANGE_NOT_ALLOWED`。修改**不會**新增作答列，只更新原列並累加
`answerChangedCount`，因此不會被誤算成兩次作答。

---

## 7. 錯題

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/mistakes` | 篩選：`subjectId`、`chapterId`、`questionGroupId`、`masteryState`、`isResolved`、`page`（`knowledgeTagIds`、`errorTypeIds` 屬 Phase 3） |
| `GET` | `/mistakes/:questionId` | 單題錯題詳情（含歷次作答） |
| `POST` | `/mistakes/practice` | 由篩選條件直接建立重練場次，回傳完整場次物件 |
| `GET` | `/mistakes/stats` | 錯題統計摘要 |

回應包含 `mistakeCount`、`consecutiveCorrect`、`totalAttempts`、`recentAccuracy`、
`masteryState`、`lastMissedAt`、`isResolved`。

**本資源沒有刪除端點，這是刻意的**：答對一次不刪除錯題紀錄（FR-MIS-05），只改變 `masteryState`。

錯題紀錄是 `user_answers` 的**衍生狀態**：每次作答後由該題完整作答歷史重新摺疊算出，
而不是「答錯就 +1」的增量累加。因為使用者可以修改答案，增量寫法必須反向扣回上一次的效果，
而 `mistakeCount` / `consecutiveCorrect` / `masteryState` 的反向運算並不唯一。
重算則是冪等的，且 Phase 4 的爭議題排除（`is_provisional`）只要加在同一個查詢條件即可。

`totalAttempts` 是該題的作答筆數（直接數 `user_answers`），與詳情頁列出的歷次作答一致。

---

## 7.1 學習概況

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/stats/overview` | 題庫規模、作答數與正確率、平均作答時間、錯題分布、近期場次、各科目表現 |

所有正確率相關數字一律排除 `is_provisional = true` 的作答（FR-QUIZ-14）。
該欄位在 Phase 2 就建立且預設為 `false`，因此現在的結果不受影響，
而 Phase 4 開始標記爭議題時統計會自動正確，不需要回頭改查詢。

---

## 8. 標籤

| 方法 | 路徑 |
|---|---|
| `GET` `POST` | `/knowledge-tags` |
| `PATCH` `DELETE` | `/knowledge-tags/:id` |
| `POST` | `/knowledge-tags/:id/merge` — `{ "targetTagId": "uuid" }` |
| `POST` | `/knowledge-tags/:id/deprecate` |
| `GET` `POST` `DELETE` | `/tag-aliases` |
| `GET` `POST` `PATCH` | `/skill-tags` |
| `GET` `PATCH` | `/error-types` |
| `GET` | `/tag-suggestions?status=pending` |
| `POST` | `/tag-suggestions/:id/approve` — 建立正式標籤 |
| `POST` | `/tag-suggestions/:id/merge` — `{ "targetTagId": "uuid" }` |
| `POST` | `/tag-suggestions/:id/reject` |

合併時既有題目關聯一併轉移，來源標籤狀態改為 `merged` 並記錄 `merged_into_id`；不刪除資料。

---

## 9. AI

| 方法 | 路徑 | 說明 |
|---|---|---|
| `POST` | `/ai/questions/:id/analyze` | 啟動單題分析，回 `{ jobId, status, reused }` |
| `GET` | `/ai/jobs/:id` | **進度輪詢端點** |
| `GET` | `/ai/jobs` | 任務列表（可篩 `status`） |
| `POST` | `/ai/jobs/:id/cancel` | |
| `POST` | `/ai/jobs/:id/retry` | 重跑失敗任務 |
| `GET` | `/questions/:id/enrichment` | 題目層級通用解析 |
| `GET` | `/questions/:id/analysis?userAnswerId=` | 個人化錯因分析 |
| `POST` | `/ai/aggregate-analyses` | 啟動多題整合分析 |
| `GET` | `/ai/aggregate-analyses/:id` | |
| `GET` | `/ai/usage` | 用量統計與明細 |

`POST /ai/questions/:id/analyze` 請求：
```json
{ "userAnswerId": "uuid", "force": false }
```

回應：
```json
{ "jobId": "uuid", "status": "pending", "reused": false }
```

- `reused: true` 表示命中快取，未實際呼叫模型。
- 相同 `idempotencyKey` 的任務已在執行中時，回傳既有 `jobId`（不重複建立）。

`GET /ai/jobs/:id` 回應：
```json
{
  "id": "uuid",
  "status": "active",
  "progressStep": "SEARCHING_SOURCES",
  "progressPct": 40,
  "attempts": 1,
  "errorCode": null,
  "resultRef": null,
  "startedAt": "2026-07-30T14:31:00.000Z"
}
```

前端以 1.5 秒間隔輪詢，`status` 進入 `completed` / `failed` / `cancelled` 即停止。

---

## 10. 答案衝突

| 方法 | 路徑 |
|---|---|
| `GET` | `/answer-conflicts?reviewStatus=pending` |
| `GET` | `/answer-conflicts/:id` |
| `POST` | `/answer-conflicts/:id/resolve` |

`resolve` 請求：
```json
{
  "decision": "answer_updated",
  "newCorrectAnswers": ["C"],
  "newExplanation": "...",
  "note": "查證後確認題庫答案有誤"
}
```

`decision` 可為 `kept_original`／`answer_updated`／`explanation_updated`／`marked_disputed`／`question_excluded`。

> **系統永遠不會自動執行這個動作。** 沒有人工裁決前，題目維持 `disputed`，相關作答維持 `is_provisional = true`。

---

## 11. 統計與設定

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/stats/overview` | 儀表板摘要 |
| `GET` | `/stats/accuracy?groupBy=subject\|chapter\|question_group\|knowledge_tag` | 正確率 |
| `GET` | `/stats/trends?period=30d` | 近期趨勢 |
| `GET` `PATCH` | `/settings` | 系統設定 |
| `GET` | `/health` | 存活檢查 |
| `GET` | `/health/deps` | PostgreSQL 與 Redis 狀態 |

> 所有統計查詢一律加上 `WHERE user_answers.is_provisional = false`，確保爭議題不汙染能力診斷（驗收標準 #18）。
