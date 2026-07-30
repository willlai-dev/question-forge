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
