import { createHash } from 'node:crypto';

/**
 * 題目內容雜湊。
 *
 * 這是 AI 快取失效的唯一判準（規格 §12、docs/ERD.md §9）：
 * 題幹、選項或正確答案任一變動都會改變雜湊，既有 AI 解析自動失效。
 *
 * 正規化規則刻意明確定義，因為它決定了「什麼算是同一題」：
 *   - 題幹與選項文字去除前後空白、將連續空白壓成單一空白。
 *   - 選項依 key 排序 —— 只調整選項「顯示順序」不算內容變更，
 *     否則作答時的選項隨機化會誤觸重新分析。
 *   - 正確答案排序後比對，與宣告順序無關。
 *   - 不含解析：解析變動不影響題目本身的研究結果。
 */

export interface HashableOption {
  key: string;
  text: string;
  isCorrect: boolean;
}

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, ' ');

export function computeQuestionContentHash(input: {
  type: string;
  stem: string;
  options: HashableOption[];
}): string {
  const options = [...input.options]
    .map((option) => ({
      key: option.key.trim().toUpperCase(),
      text: normalizeText(option.text),
      isCorrect: option.isCorrect,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const correctAnswers = options
    .filter((option) => option.isCorrect)
    .map((option) => option.key)
    .sort();

  const payload = JSON.stringify({
    type: input.type,
    stem: normalizeText(input.stem),
    options: options.map((option) => [option.key, option.text]),
    correctAnswers,
  });

  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** 單筆筆記的內容雜湊。與題目用同一套文字正規化。 */
export function computeNoteContentHash(content: string): string {
  return createHash('sha256').update(normalizeText(content), 'utf8').digest('hex');
}

/**
 * 一次分析所依據的筆記集合指紋。
 *
 * 為什麼需要它：`questionContentHash` 只涵蓋題目本身。筆記重新匯入之後，
 * 題目沒變、雜湊不變，既有解析會繼續命中快取——使用者改了筆記卻看不到
 * 任何差別，而且完全沒有跡象說明為什麼。
 *
 * 依 noteId 排序後計算，因此**與檢索回來的順序無關**：
 * 順序變動不代表依據的內容變了，不該平白讓所有解析失效。
 * 空集合回傳固定字串，讓「這題沒有筆記」也是一個明確的狀態。
 */
export function computeNotesFingerprint(
  notes: readonly { id: string; contentHash: string }[],
): string {
  if (notes.length === 0) return 'no-notes';

  const payload = JSON.stringify(
    [...notes]
      .map((note) => [note.id, note.contentHash])
      .sort((a, b) => a[0]!.localeCompare(b[0]!)),
  );

  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
