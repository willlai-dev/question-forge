/**
 * 章節筆記的檢索排序。
 *
 * 零 import 的純函式（與 `quiz/grading.ts`、`analysis/representative.ts` 同一個模式）：
 * 用「無法 import」在結構上證明挑選過程碰不到資料庫、時鐘與 AI。
 *
 * 為什麼不用 embedding：單章 PDF 的筆記通常只有數十段，關鍵字重疊已經夠用；
 * 而 embedding 會引入模型呼叫、額外相依與不確定性，讓「同一題兩次挑出不同筆記」
 * 變成可能。這裡刻意保持確定性——快取判準依賴它。
 */

/** 一段可供檢索的筆記。 */
export interface RankableNote {
  id: string;
  noteKey: string;
  title: string | null;
  content: string;
  keywords: string[];
  /** 題目在匯入檔中明確關聯了這一段。 */
  explicitlyLinked: boolean;
}

export interface RankedNote extends RankableNote {
  score: number;
}

/** 明確關聯的筆記一律排在最前面，不與關鍵字分數比較。 */
const EXPLICIT_LINK_SCORE = 1_000_000;

/** keywords 命中比正文命中更有代表性——它是人為標註的主題詞。 */
const KEYWORD_HIT_WEIGHT = 10;
const TITLE_HIT_WEIGHT = 5;
const CONTENT_HIT_WEIGHT = 1;

/** 少於這個長度的詞不拿來比對：「的」「之」這類字元命中率極高卻沒有鑑別力。 */
const MIN_TERM_LENGTH = 2;

/** 從題幹與選項抽出的比對詞上限，避免長題目讓每段筆記都得高分。 */
const MAX_TERMS = 40;

/**
 * 依與題目的相關度排序筆記。
 *
 * 排序是**全序**：分數相同時以 noteKey 字典序收尾。
 * 少了這一層，兩段同分的筆記會退回資料庫的回傳順序，
 * 而 PostgreSQL 不保證跨次一致——同一題就可能挑出不同筆記，
 * 快取指紋跟著跳動，「筆記沒變就不重跑」的保證就沒了。
 */
export function rankNotesForQuestion(
  notes: readonly RankableNote[],
  questionText: string,
): RankedNote[] {
  const terms = extractTerms(questionText);

  return notes
    .map((note) => ({ ...note, score: scoreNote(note, terms) }))
    .sort((a, b) => (b.score - a.score) || a.noteKey.localeCompare(b.noteKey));
}

/**
 * 依字元預算挑出實際要送進模型的筆記。
 *
 * 逐段納入，放不下就停——**不切半段**。切半的筆記在引用查核下特別麻煩：
 * 模型可能引用到被截掉的部分，於是合法的引用被判成捏造。
 * 唯一的例外是第一段：它若單獨超過預算就截斷，否則一段長筆記
 * 會讓這題完全沒有筆記可用。
 */
export function selectNotesWithinBudget(
  ranked: readonly RankedNote[],
  budgetChars: number,
): RankedNote[] {
  const selected: RankedNote[] = [];
  let used = 0;

  for (const note of ranked) {
    if (selected.length === 0 && note.content.length > budgetChars) {
      selected.push({ ...note, content: note.content.slice(0, budgetChars) });
      return selected;
    }
    if (used + note.content.length > budgetChars) continue;
    selected.push(note);
    used += note.content.length;
  }

  return selected;
}

function scoreNote(note: RankableNote, terms: readonly string[]): number {
  if (note.explicitlyLinked) return EXPLICIT_LINK_SCORE;
  if (terms.length === 0) return 0;

  const keywords = note.keywords.join(' ').toLowerCase();
  const title = (note.title ?? '').toLowerCase();
  const content = note.content.toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (keywords.includes(term)) score += KEYWORD_HIT_WEIGHT;
    if (title.includes(term)) score += TITLE_HIT_WEIGHT;
    // 正文只計「有沒有出現」，不計次數：計次會讓長筆記單純因為篇幅而勝出。
    if (content.includes(term)) score += CONTENT_HIT_WEIGHT;
  }
  return score;
}

/**
 * 從題目文字抽出比對詞。
 *
 * 中文沒有空白分詞，因此採用「連續同類字元切段 + 中文再取 2-gram」：
 * 「期貨交易稅」會產生 期貨、貨交、交易、易稅 等 2-gram，
 * 足以和筆記中的「期貨交易稅」對上，且不需要引入斷詞器。
 */
function extractTerms(text: string): string[] {
  const lower = text.toLowerCase();
  const terms = new Set<string>();

  // 英數詞（法條編號、專有名詞縮寫）
  for (const match of lower.matchAll(/[a-z0-9]{2,}/g)) {
    terms.add(match[0]);
  }

  // 中日韓字元連續段落 → 2-gram
  for (const match of lower.matchAll(/[一-鿿]{2,}/g)) {
    const segment = match[0];
    for (let i = 0; i + MIN_TERM_LENGTH <= segment.length; i += 1) {
      terms.add(segment.slice(i, i + MIN_TERM_LENGTH));
      if (terms.size >= MAX_TERMS) return [...terms];
    }
  }

  return [...terms].slice(0, MAX_TERMS);
}
