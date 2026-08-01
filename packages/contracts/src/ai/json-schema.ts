import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * 把 Zod schema 轉成 NVIDIA `response_format.json_schema` 接受的形式。
 *
 * 實測結論（docs/AI_ANALYSIS_SCHEMAS.md §6）：
 *   - `strict: true` 時每個物件都必須有 `additionalProperties: false`。
 *   - `strict: true` 時**所有屬性都必須列在 `required`**，
 *     少一個就會被硬性 400 拒絕。Zod 的 `.optional()` 不會進 required，
 *     因此 schema 一律用 `.nullable()` 表達「可以沒有值」。
 *   - `$ref` / `definitions` 在部分情況下會被拒絕，故關閉引用抽取。
 *
 * 這裡的後處理是把上述限制強制套用到整棵樹，
 * 而不是仰賴每個 schema 作者都記得寫對。
 */
export function toStrictJsonSchema(schema: ZodTypeAny, name: string): Record<string, unknown> {
  // 這裡刻意退回 never：zodToJsonSchema 會沿著巢狀 schema 展開泛型，
  // 遇到本專案這種深度的 schema 會讓 TypeScript 觸發「型別實例化過深」而無法編譯。
  // 產物本來就是任意 JSON，泛型推導對呼叫端沒有價值。
  const generated = zodToJsonSchema(schema as never, {
    name,
    // 全部展開，不產生 $ref —— 避免 provider 對引用的支援差異。
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as Record<string, unknown>;

  // zodToJsonSchema 會把結果包在 definitions[name] 底下。
  const definitions = generated.definitions as Record<string, unknown> | undefined;
  const root = (definitions?.[name] ?? generated) as Record<string, unknown>;

  return enforceStrict(stripMetadata(root));
}

/** 移除 provider 不需要、且可能觸發嚴格模式錯誤的欄位。 */
function stripMetadata(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripMetadata);
  if (node === null || typeof node !== 'object') return node;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$schema' || key === 'default' || key === 'definitions') continue;
    result[key] = stripMetadata(value);
  }
  return result;
}

/** 遞迴套用 `additionalProperties: false` 並把所有屬性列入 `required`。 */
function enforceStrict(node: unknown): Record<string, unknown> {
  if (Array.isArray(node)) {
    return node.map((item) => enforceStrict(item)) as unknown as Record<string, unknown>;
  }
  if (node === null || typeof node !== 'object') {
    return node as Record<string, unknown>;
  }

  const source = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    result[key] =
      value !== null && typeof value === 'object' ? enforceStrict(value) : value;
  }

  if (result.type === 'object' && result.properties && typeof result.properties === 'object') {
    result.additionalProperties = false;
    result.required = Object.keys(result.properties as Record<string, unknown>);
  }

  return result;
}
