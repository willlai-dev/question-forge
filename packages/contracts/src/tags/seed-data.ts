/**
 * 受控詞彙的種子資料（FR-TAG-04、FR-TAG-05）。
 *
 * 放在 contracts 而非 db，是因為 Phase 4 的 AI prompt 也需要這份清單 ——
 * 「只能從下列錯誤類型中選擇」的那份清單必須與資料庫的種子完全一致，
 * 兩邊各抄一份遲早會漂移。
 */

export interface SkillTagSeed {
  slug: string;
  name: string;
  description: string;
}

/** 能力類型：這一題考的是哪一種能力。 */
export const SKILL_TAG_SEEDS: readonly SkillTagSeed[] = [
  {
    slug: '概念辨識',
    name: '概念辨識',
    description: '判斷某個名詞、制度或概念的定義與範圍。',
  },
  {
    slug: '條件判斷',
    name: '條件判斷',
    description: '題目給定條件後，判斷是否符合某項規定的要件。',
  },
  {
    slug: '規則適用',
    name: '規則適用',
    description: '將條文或公式正確套用到題目描述的情境。',
  },
  {
    slug: '案例推理',
    name: '案例推理',
    description: '從具體案例推導出應適用的結論，通常需要多步推理。',
  },
  {
    slug: '例外規則辨識',
    name: '例外規則辨識',
    description: '辨認出原則之外的例外、但書或排除條款。',
  },
  {
    slug: '資料判讀',
    name: '資料判讀',
    description: '從圖表、數據或財報等資料中讀出結論。',
  },
] as const;

export interface ErrorTypeSeed {
  code: string;
  name: string;
  description: string;
  isFallback: boolean;
}

/**
 * 錯誤類型：這一題為什麼錯。
 *
 * `code` 是穩定識別碼，使用者改名不影響它；AI prompt 與統計一律以 code 為準。
 * 最後一項 `undetermined` 是 fallback，**不可移除** ——
 * 沒有它，AI 判斷不出錯因時就會被迫從具體選項中亂猜一個，
 * 產生看起來明確、實際上沒有根據的診斷。
 */
export const ERROR_TYPE_SEEDS: readonly ErrorTypeSeed[] = [
  {
    code: 'concept_confusion',
    name: '概念混淆',
    description: '把兩個相似但不同的概念搞混。',
    isFallback: false,
  },
  {
    code: 'ignored_condition',
    name: '忽略題目條件',
    description: '題目已明確給定的條件被忽略或看漏。',
    isFallback: false,
  },
  {
    code: 'missed_exception',
    name: '例外規則遺漏',
    description: '只記得原則，忽略了但書或例外情形。',
    isFallback: false,
  },
  {
    code: 'misapplied_rule',
    name: '規則適用錯誤',
    description: '認得規則，但套用到不該套用的情境。',
    isFallback: false,
  },
  {
    code: 'option_comparison',
    name: '選項比較錯誤',
    description: '在兩個接近的選項之間選錯，通常是沒抓到關鍵差異。',
    isFallback: false,
  },
  {
    code: 'memory_error',
    name: '記憶錯誤',
    description: '記錯數字、名稱、期限或條號等需要記憶的內容。',
    isFallback: false,
  },
  {
    code: 'reasoning_break',
    name: '推理中斷',
    description: '前段推理正確，但中途斷掉或跳步導致結論錯誤。',
    isFallback: false,
  },
  {
    code: 'undetermined',
    name: '無法判定',
    description: '現有資訊不足以判斷錯誤原因。保留此項是為了避免被迫亂猜。',
    isFallback: true,
  },
] as const;

/** fallback 錯誤類型的 code。Phase 4 的 AI 輸出驗證會用到。 */
export const FALLBACK_ERROR_TYPE_CODE = 'undetermined';
