/**
 * 中文分數與百分比的一致性檢查。
 *
 * 起因是一次真實的錯誤解析：模型寫出「稅率為契約金額的0.02%（10萬分之2）」。
 * 10萬分之2 = 0.002%，它在同一個句子裡自我否定。判定這種錯誤不需要任何外部
 * 知識或模型呼叫——純算術就夠——所以不該讓它流到使用者面前。
 *
 * 只在兩個數字**緊鄰**時比較（中間僅有括號、逗號、「即」這類同位語連接詞）。
 * 距離一放寬，「股票千分之3、公司債千分之1，合計約0.4%」這種各自獨立的數字
 * 就會被誤判成矛盾。寧可漏抓也不要誤殺——誤殺會讓合法的解析反覆重生到失敗。
 */

const DIGIT_MAP: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const UNIT_MAP: Readonly<Record<string, number>> = {
  十: 10,
  百: 100,
  千: 1000,
  萬: 10_000,
  万: 10_000,
  億: 100_000_000,
  亿: 100_000_000,
};

/** 分數兩側可能出現的字元。含 `.` 是為了「0.5分之…」這類寫法。 */
const NUMBER_CHARS = '0-9.零〇一二兩三四五六七八九十百千萬万億亿';

const FRACTION_PATTERN = `([${NUMBER_CHARS}]+)分之([${NUMBER_CHARS}]+)`;
const PERCENT_PATTERN = '([0-9]+(?:\\.[0-9]+)?)\\s*%';

/**
 * 兩個數字之間允許出現的連接字元。
 *
 * 這份清單就是「緊鄰」的定義：只有同位語（括號、「即」、「亦即」、「也就是」、
 * 「等於」、「約」）才算在講同一件事。任何實詞出現都代表這是兩個獨立的數字。
 */
const CONNECTOR_ONLY = /^[\s（）()【】[\]，,、：:＝=即亦也就是等於于為为約约]*$/;

/** 連接字元的長度上限。「，亦即約」已經是 4 個字，6 足夠涵蓋正常寫法。 */
const MAX_GAP_CHARS = 6;

/**
 * 相對誤差容忍度。
 *
 * 取 5% 是因為要擋的是量級錯誤（10 倍、100 倍、1000 倍），而要放過的是
 * 四捨五入（「三分之一（約33%）」的誤差約 1%）。兩者差距極大，不必精算。
 */
const RELATIVE_TOLERANCE = 0.05;

export interface NumericInconsistency {
  /** 原文中的分數寫法，例如「10萬分之2」。 */
  fraction: string;
  /** 該分數換算成百分比後的值。 */
  fractionAsPercent: number;
  /** 同一處寫出的百分比。 */
  statedPercent: number;
}

/**
 * 找出文字中「分數」與「緊鄰的百分比」對不起來的地方。
 *
 * 回傳空陣列代表沒有可機械判定的矛盾——不代表數字正確。
 */
export function findNumericInconsistencies(text: string): NumericInconsistency[] {
  const normalized = normalizeDigits(text);

  const percents = [...normalized.matchAll(new RegExp(PERCENT_PATTERN, 'g'))].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    value: Number(match[1]),
  }));
  if (percents.length === 0) return [];

  const found: NumericInconsistency[] = [];

  for (const match of normalized.matchAll(new RegExp(FRACTION_PATTERN, 'g'))) {
    const start = match.index;
    const end = start + match[0].length;

    const denominator = parseChineseNumber(match[1] ?? '');
    const numerator = parseChineseNumber(match[2] ?? '');
    if (denominator === null || numerator === null || denominator === 0) continue;

    const asPercent = (numerator / denominator) * 100;

    // 只看緊鄰的百分比。有任何一個對得上就當作沒問題——
    // 一個分數旁邊同時出現對得上與對不上的百分比時，前者才是它的同位語。
    const adjacent = percents.filter((percent) => {
      const gap =
        percent.start >= end
          ? normalized.slice(end, percent.start)
          : percent.end <= start
            ? normalized.slice(percent.end, start)
            : null;
      return gap !== null && gap.length <= MAX_GAP_CHARS && CONNECTOR_ONLY.test(gap);
    });
    if (adjacent.length === 0) continue;

    const tolerance = Math.max(asPercent * RELATIVE_TOLERANCE, Number.EPSILON);
    if (adjacent.some((percent) => Math.abs(percent.value - asPercent) <= tolerance)) continue;

    found.push({
      fraction: match[0],
      fractionAsPercent: asPercent,
      statedPercent: adjacent[0]!.value,
    });
  }

  return found;
}

/** 去掉浮點運算的尾數雜訊，讓錯誤訊息裡的數字是人看得懂的。 */
export function formatPercent(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/** 全形數字與百分號一律轉半形，後面的比對只需處理半形。 */
function normalizeDigits(text: string): string {
  return text
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/％/g, '%')
    .replace(/．/g, '.');
}

/**
 * 解析中文／阿拉伯數字混寫的數值，無法解析時回傳 null。
 *
 * 支援「10萬」「十萬」「千」「二十」這類寫法——台灣稅率文字兩種都會出現，
 * 只認其中一種等於放掉一半的案例。
 */
function parseChineseNumber(token: string): number | null {
  let index = 0;
  let total = 0;
  let section = 0;
  let current = 0;
  let sawAny = false;

  while (index < token.length) {
    const digits = /^[0-9]+(?:\.[0-9]+)?/.exec(token.slice(index));
    if (digits) {
      current = Number(digits[0]);
      index += digits[0].length;
      sawAny = true;
      continue;
    }

    const char = token[index]!;

    const digit = DIGIT_MAP[char];
    if (digit !== undefined) {
      current = digit;
      index += 1;
      sawAny = true;
      continue;
    }

    const unit = UNIT_MAP[char];
    if (unit === undefined) return null;
    if (unit >= 10_000) {
      // 萬、億是節點單位：把目前累積的一整節乘上去後落袋。
      section = (section + current) * unit;
      total += section;
      section = 0;
    } else {
      // 「十」單獨出現時代表 10，不是 0。
      section += (current === 0 ? 1 : current) * unit;
    }
    current = 0;
    index += 1;
    sawAny = true;
  }

  if (!sawAny) return null;
  const value = total + section + current;
  return Number.isFinite(value) ? value : null;
}
