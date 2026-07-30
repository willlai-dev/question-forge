# PDF 題庫整理 Prompt（QUESTION_IMPORT_PROMPT）

> 版本：`import-prompt@1.0.0`
> 用途：交給具備 PDF 閱讀能力的外部大型語言模型（GPT、Claude 等），把 PDF 題庫轉成本系統可匯入的 JSON。
> 系統內可由 `GET /imports/prompt` 取得同一份文字，前端「JSON 匯入」頁面提供一鍵複製。

---

## 使用方式

1. 開啟具 PDF 閱讀能力的 AI 對話。
2. **完整複製下方「Prompt 本文」區塊**貼上。
3. 附上 PDF 檔案。
4. 取得輸出後存成 `.json` 檔。
5. 回到本系統 `/imports/new` 上傳，進入預覽與驗證流程。

> 外部模型的輸出**一律視為未驗證資料**。本系統會完整重跑一次驗證，錯誤不會寫入正式題庫。
> 因此就算外部模型出錯，也不會污染題庫——只會在預覽頁列出問題等你處理。

---

## Prompt 本文

```text
你是一個嚴謹的題庫資料整理員。你的唯一任務是把我提供的 PDF 中的「選擇題」擷取出來，
轉換成指定格式的 JSON。

# 絕對規則（違反其中任何一條，這次輸出即為無效）

1. 只輸出 JSON 本體。不要輸出 Markdown、不要用 ``` 包裹、不要加任何說明文字或前後言。
2. 不得新增 PDF 中不存在的題目。一題都不可以憑空產生。
3. 不得改變題目原意。題幹與選項必須是 PDF 的原文，不得改寫、不得摘要、不得「修正」用字。
4. 必須保留完整題幹與所有選項，不得省略、不得截斷。
5. 必須保留原始題號與來源頁碼。
6. 不確定答案時，把 reviewRequired 設為 true，並在 reviewReason 說明原因。
7. PDF 沒有提供解析時，explanation 必須是 null。**絕對不可以自行編造解析。**
8. 跨頁的題目必須合併成一則完整的題目。
9. 選項代號統一使用大寫英文字母：A、B、C、D…。原文若用 (1)(2)(3)(4) 或甲乙丙丁，
   請依序對應為 A、B、C、D，但選項「文字內容」仍須保留原文。
10. 只處理單選題與複選題。填充題、簡答題、申論題、計算題請整個略過，不要嘗試轉換。

# 輸出格式

輸出一個 JSON 物件，結構如下：

{
  "schemaVersion": "1.0.0",
  "subject": {
    "name": "科目名稱",
    "code": null,
    "description": null
  },
  "chapter": {
    "name": "章節名稱",
    "description": null,
    "sortOrder": null
  },
  "questionGroup": {
    "name": "題組名稱，例如「112年地方特考三等 行政法」",
    "description": null,
    "source": "來源，例如「112年地方特考」",
    "year": 2023,
    "notes": null
  },
  "sourceDocument": {
    "filename": "原始 PDF 檔名",
    "title": null,
    "totalPages": 18
  },
  "questions": [
    {
      "externalId": "此題的唯一識別，建議格式：<來源代號>-Q<題號>",
      "questionNumber": 12,
      "type": "single_choice",
      "stem": "完整題幹原文",
      "options": [
        { "key": "A", "text": "選項 A 的完整原文" },
        { "key": "B", "text": "選項 B 的完整原文" },
        { "key": "C", "text": "選項 C 的完整原文" },
        { "key": "D", "text": "選項 D 的完整原文" }
      ],
      "correctAnswers": ["B"],
      "explanation": null,
      "sourcePage": 5,
      "sourceReference": "第三章 行政行為",
      "reviewRequired": false,
      "reviewReason": null,
      "knowledgeHints": ["此題考查的知識點（選填，最多 3 個）"]
    }
  ]
}

# 欄位規則

- schemaVersion：固定填 "1.0.0"。
- chapter：PDF 若沒有章節結構，整個填 null。
- type：只能是 "single_choice" 或 "multiple_choice"。
  題目若出現「複選」「多選」「選出所有」等字樣，或答案有多個，就是 multiple_choice。
- correctAnswers：陣列，內容是選項的 key。
  - single_choice 必須「恰好一個」元素。
  - multiple_choice 必須「至少兩個」元素。
  - 每個值都必須真的出現在該題的 options 裡面。
- explanation：PDF 有解析就照抄；沒有就填 null。不可自己寫。
- sourcePage：該題在 PDF 的頁碼（整數）。跨頁時填題目「開始」的那一頁。
- sourceReference：章節標題或其他來源標示；沒有就填 null。
- reviewRequired：下列任一情況為 true：
  - PDF 沒有標示答案
  - 答案標示模糊、被遮住、或 OCR 疑似辨識錯誤
  - 題目內容明顯不完整（例如缺圖、缺附表而無法作答）
  - 你對正確答案沒有把握
- reviewReason：reviewRequired 為 true 時必填，簡短說明原因；否則填 null。
- externalId：同一份輸出裡不得重複。
- questionNumber：同一份輸出裡不得重複；若 PDF 分節重新編號，請在 externalId 中加入節次區分。

# 品質檢查（輸出前請自行確認）

在給出結果之前，逐條檢查：

□ 輸出是純 JSON，沒有 ``` 包裹，沒有任何說明文字
□ 每一題都真的來自 PDF，沒有任何一題是我生成的
□ 題幹與選項都是原文，沒有改寫或摘要
□ 每題至少有兩個選項
□ 同一題的選項 key 沒有重複
□ 每個 correctAnswers 的值都出現在該題的 options 中
□ 單選題只有一個答案；複選題至少兩個答案
□ 沒有解析的題目，explanation 是 null（不是空字串、不是我編的內容）
□ externalId 與 questionNumber 都沒有重複
□ 跨頁題目已經合併完整
□ 選項代號已統一為大寫英文字母

如果 PDF 中有任何題目你無法確定，請照樣輸出該題，
但把 reviewRequired 設為 true 並說明原因——不要略過它，也不要猜一個答案然後假裝有把握。

現在請開始處理我提供的 PDF。
```

---

## 設計說明（給維護者，不屬於 Prompt 本文）

### 為什麼要求「只輸出 JSON、不要 Markdown」

外部模型預設會用 ```json 包裹並加上說明文字，導致使用者存檔後無法直接匯入。
明確禁止可大幅降低使用者手動清理的負擔。本系統的上傳端點仍會容錯處理最外層的 ``` 包裹，
但這是防禦而非預期路徑。

### 為什麼「沒有解析必須是 null」寫得這麼重

這是整份 Prompt 最重要的一條。LLM 面對空白欄位的天性是「幫你補上」，
而編造的解析會混入題庫、被 AI 分析當成題庫原有解析參考、最終污染學習判斷。
因此規格 §5 明文要求，本 Prompt 也在「絕對規則」與「品質檢查」中重複兩次。

匯入驗證會把 `explanation: null` 標為 **warning**（`MISSING_EXPLANATION`）而非 error——
缺解析是可接受的狀態，系統之後可以用 AI 補上並清楚標示為 AI 產生。

### 為什麼保留 `reviewRequired` 而不是要求模型一定給答案

強迫模型給出答案，就是強迫它在不確定時猜測，而猜測的答案看起來與確定的答案完全一樣。
`reviewRequired` 讓不確定性顯性化，並在預覽介面醒目標示（FR-IMP-07），由人決定。

### 版本管理

本 Prompt 的版本號 `import-prompt@1.0.0` 與 `schemaVersion` 綁定。
若日後 Schema 改版（例如新增題型），Prompt 與 Schema 必須同步升版，
且系統需同時支援舊版 `schemaVersion` 的匯入檔，避免舊檔案失效。
