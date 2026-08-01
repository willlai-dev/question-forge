import type { AiOperation } from '@repo/contracts';

/**
 * AI Provider 抽象（規格 §二要求「AI 供應商可替換」）。
 *
 * **業務程式一律只注入 AiGatewayService，不得直接使用 Provider。**
 * 限流、重試、schema 驗證與用量記錄都在 Gateway，
 * 若各處自行呼叫 Provider，那些保護就會被繞過。
 */

export interface AiChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface AiCompletionRequest {
  operation: AiOperation;
  messages: AiChatMessage[];
  /** 送給 provider 的結構化輸出限制（NVIDIA 的 json_schema）。 */
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  maxTokens: number;
  temperature: number;
  reasoningEffort: string;
}

export interface AiCompletionResult {
  /** 模型回傳的原始文字（預期是 JSON）。 */
  content: string;
  finishReason: string | null;
  model: string;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  };
  httpStatus: number;
}

/** Provider 層的錯誤，帶上足以決定「該不該重試」的資訊。 */
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'rate_limited' | 'http_error' | 'timeout' | 'bad_request',
    readonly httpStatus: number | null = null,
    /** 429 時 provider 給的建議等待時間；NVIDIA 實測不給，故通常為 null。 */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');
