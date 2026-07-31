/**
 * 判分。
 *
 * 規格 §六（FR-QUIZ-10）硬性要求：**判分完全由程式執行，不使用 AI**。
 * 因此這裡刻意寫成不依賴任何外部資源的純函式，可被單元測試逐條證明。
 */

/**
 * 把答案代號正規化成可比較的形式：去空白、轉大寫、去重、排序。
 *
 * 排序是「複選題答案順序無關」的實作基礎 —— 使用者先選 D 再選 B，
 * 與先選 B 再選 D，必須被視為完全相同的作答。
 */
export function normalizeAnswerKeys(keys: readonly string[]): string[] {
  const cleaned = keys.map((key) => key.trim().toUpperCase()).filter((key) => key.length > 0);
  return [...new Set(cleaned)].sort();
}

/**
 * 判定一次作答是否正確。
 *
 * 規則（規格 §六）：
 *   - 單選：所選代號等於正確代號。
 *   - 複選：**完全一致才算對**，順序無關；部分正確不給分、多選也不給分。
 *
 * 正確答案為空時一律判為錯 —— 若照集合相等處理，空作答會與空答案「相等」而被判成答對，
 * 那是資料異常被靜默吞掉，不是使用者真的答對了。
 */
export function gradeAnswer(
  selectedAnswers: readonly string[],
  correctAnswers: readonly string[],
): boolean {
  const correct = normalizeAnswerKeys(correctAnswers);
  if (correct.length === 0) return false;

  const selected = normalizeAnswerKeys(selectedAnswers);
  if (selected.length !== correct.length) return false;

  return selected.every((key, index) => key === correct[index]);
}
