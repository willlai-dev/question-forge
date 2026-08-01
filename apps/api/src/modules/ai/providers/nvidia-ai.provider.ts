import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Env } from '@repo/contracts';

import { ENV } from '../../../config/env.config';
import {
  AiProviderError,
  type AiCompletionRequest,
  type AiCompletionResult,
  type AiProvider,
} from './ai-provider';

/**
 * NVIDIA NIM provider。
 *
 * 這是**唯一**知道 NVIDIA API 細節的地方。所有參數與錯誤格式都來自規劃階段的實測：
 *
 *   - `response_format: json_schema` + `strict: true` 由伺服器端強制結構正確。
 *   - `reasoning_effort` 是合法參數，值域 none|minimal|low|medium|high|xhigh|max。
 *   - **未知的頂層參數會被硬性 400 拒絕**，因此只能送白名單參數。
 *   - 錯誤格式為 `{"error":{message,type,code}}`。
 *   - 回應完全沒有任何限流標頭，429 時也沒有 Retry-After。
 *   - reasoning token 計入 completion_tokens，max_tokens 不足會 finish_reason: "length"。
 */
@Injectable()
export class NvidiaAiProvider implements AiProvider {
  readonly name = 'nvidia';
  private readonly logger = new Logger(NvidiaAiProvider.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  get model(): string {
    return this.env.NVIDIA_MODEL;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.env.NVIDIA_REQUEST_TIMEOUT_MS);

    // 只送白名單參數。多送任何一個未知欄位都會被 400 拒絕（實測）。
    const body = {
      model: this.env.NVIDIA_MODEL,
      messages: request.messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      reasoning_effort: request.reasoningEffort,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: request.schemaName,
          strict: true,
          schema: request.jsonSchema,
        },
      },
    };

    let response: Response;
    try {
      response = await fetch(`${this.env.NVIDIA_API_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.env.NVIDIA_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AiProviderError(
          `NVIDIA 請求超過 ${this.env.NVIDIA_REQUEST_TIMEOUT_MS}ms 逾時。`,
          'timeout',
        );
      }
      throw new AiProviderError(`無法連線至 NVIDIA API：${describe(error)}`, 'http_error');
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();

    if (!response.ok) {
      // 錯誤訊息可能含有請求內容，不直接外傳；只記錄摘要。
      const parsed = safeParse(text);
      const detail =
        (parsed as { error?: { message?: string } } | null)?.error?.message ?? '未提供細節';
      this.logger.warn(`NVIDIA 回應 ${response.status}：${detail.slice(0, 200)}`);

      if (response.status === 429) {
        // 實測不會有 Retry-After，退避時間交由 Gateway 以指數退避決定。
        throw new AiProviderError('NVIDIA 回報請求過於頻繁。', 'rate_limited', 429, null);
      }
      if (response.status >= 500) {
        throw new AiProviderError(`NVIDIA 伺服器錯誤（${response.status}）。`, 'http_error', response.status);
      }
      throw new AiProviderError(
        `NVIDIA 拒絕本次請求（${response.status}）：${detail.slice(0, 200)}`,
        'bad_request',
        response.status,
      );
    }

    const payload = safeParse(text) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    } | null;

    const choice = payload?.choices?.[0];
    if (!choice?.message?.content) {
      throw new AiProviderError('NVIDIA 回應中沒有內容。', 'http_error', response.status);
    }

    return {
      content: choice.message.content,
      finishReason: choice.finish_reason ?? null,
      model: payload?.model ?? this.env.NVIDIA_MODEL,
      usage: {
        inputTokens: payload?.usage?.prompt_tokens ?? null,
        outputTokens: payload?.usage?.completion_tokens ?? null,
        totalTokens: payload?.usage?.total_tokens ?? null,
      },
      httpStatus: response.status,
    };
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
