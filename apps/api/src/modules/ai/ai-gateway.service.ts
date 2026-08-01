import { Inject, Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES, toStrictJsonSchema, type AiOperation, type Env } from '@repo/contracts';
import { schema, type DatabaseHandle } from '@repo/db';
import type { ZodTypeAny, z } from 'zod';

import { AppException } from '../../common/app.exception';
import { ENV } from '../../config/env.config';
import { DATABASE } from '../../infra/infra.module';
import {
  AI_PROVIDER,
  AiProviderError,
  type AiChatMessage,
  type AiProvider,
} from './providers/ai-provider';
import { AiConcurrencyLimiter, AiRateLimiterService } from './rate-limiter.service';

export interface AiCallOptions<T extends ZodTypeAny> {
  operation: AiOperation;
  messages: AiChatMessage[];
  /** 送給模型的結構限制（不含需要外部資訊的語意規則）。 */
  requestSchema: ZodTypeAny;
  /** 收到回應後用來驗證的完整 schema（含語意規則）。 */
  responseSchema: T;
  maxTokens: number;
  reasoningEffort: string;
  userId: string;
  aiJobId?: string | null;
  promptVersion?: string | null;
}

export interface AiCallResult<T> {
  data: T;
  raw: unknown;
  model: string;
}

type RequestStatus =
  | 'success'
  | 'schema_invalid'
  | 'semantic_invalid'
  | 'rate_limited'
  | 'http_error'
  | 'timeout'
  | 'cancelled';

/**
 * AI 呼叫的唯一入口。
 *
 * **業務程式只能注入這個 service，不得直接用 Provider。**
 * 限流、重試、schema 驗證、用量記錄全部集中在這裡；
 * 任何繞過的呼叫路徑都會失去這些保護，而且不會有人發現。
 *
 * 重試策略（規格 §14，**絕不無限重試**）：
 *   - 429：指數退避 + jitter，上限 NVIDIA_MAX_RETRIES_429
 *   - 5xx：指數退避，上限 NVIDIA_MAX_RETRIES_5XX
 *   - finish_reason = length：視為結構失敗，提高 max_tokens 重試一次
 *   - schema／語意驗證失敗：附上錯誤說明要求重新生成，上限 NVIDIA_MAX_SCHEMA_REGENERATIONS
 *   - 其他 4xx：立即失敗，不重試（參數錯誤重試幾次都一樣）
 */
@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);
  private readonly schemaCache = new Map<string, Record<string, unknown>>();

  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    @Inject(DATABASE) private readonly database: DatabaseHandle,
    @Inject(ENV) private readonly env: Env,
    private readonly rateLimiter: AiRateLimiterService,
    private readonly concurrency: AiConcurrencyLimiter,
  ) {}

  get model(): string {
    return this.provider.model;
  }

  get providerName(): string {
    return this.provider.name;
  }

  async call<T extends ZodTypeAny>(options: AiCallOptions<T>): Promise<AiCallResult<z.infer<T>>> {
    const jsonSchema = this.jsonSchemaFor(options.operation, options.requestSchema);

    let messages = options.messages;
    let maxTokens = options.maxTokens;
    let regenerations = 0;
    let transportRetries = 0;
    let attemptIndex = 0;
    let lastError: Error | null = null;

    // 迴圈上限是兩種重試次數的總和加一，確保任何路徑都會終止。
    const hardLimit =
      this.env.NVIDIA_MAX_SCHEMA_REGENERATIONS +
      Math.max(this.env.NVIDIA_MAX_RETRIES_429, this.env.NVIDIA_MAX_RETRIES_5XX) +
      3;

    while (attemptIndex < hardLimit) {
      const isRetry = attemptIndex > 0;
      const startedAt = Date.now();

      const permit = await this.rateLimiter.tryAcquire(isRetry);
      if (!permit.allowed) {
        await this.log(options, {
          status: 'rate_limited',
          latencyMs: 0,
          attemptIndex,
          retryCount: transportRetries,
          errorCode: ERROR_CODES.AI_PROVIDER_RATE_LIMITED,
          errorMessage: `本地限流器擋下，${permit.retryAfterMs}ms 後重試`,
        });

        if (transportRetries >= this.env.NVIDIA_MAX_RETRIES_429) {
          throw new AppException(
            ERROR_CODES.AI_PROVIDER_RATE_LIMITED,
            '已達本分鐘的 AI 呼叫上限，請稍後再試。',
          );
        }
        transportRetries += 1;
        attemptIndex += 1;
        await sleep(permit.retryAfterMs + jitter());
        continue;
      }

      try {
        const result = await this.concurrency.run(() =>
          this.provider.complete({
            operation: options.operation,
            messages,
            jsonSchema,
            schemaName: options.operation,
            maxTokens,
            temperature: this.env.AI_TEMPERATURE,
            reasoningEffort: options.reasoningEffort,
          }),
        );
        const latencyMs = Date.now() - startedAt;

        // reasoning token 計入 completion_tokens，額度不足會讓 JSON 被截斷。
        // 這不是模型的錯，是我們給的空間不夠，因此提高上限重試一次。
        if (result.finishReason === 'length' && regenerations < 1) {
          await this.log(options, {
            status: 'schema_invalid',
            latencyMs,
            attemptIndex,
            retryCount: transportRetries,
            finishReason: result.finishReason,
            httpStatus: result.httpStatus,
            usage: result.usage,
            errorCode: ERROR_CODES.AI_OUTPUT_SCHEMA_INVALID,
            errorMessage: 'finish_reason 為 length，輸出被截斷',
          });
          maxTokens = Math.floor(maxTokens * 1.5);
          regenerations += 1;
          attemptIndex += 1;
          continue;
        }

        const parsed = safeJsonParse(result.content);
        if (parsed === undefined) {
          lastError = new Error('模型輸出不是合法 JSON');
          await this.log(options, {
            status: 'schema_invalid',
            latencyMs,
            attemptIndex,
            retryCount: transportRetries,
            finishReason: result.finishReason,
            httpStatus: result.httpStatus,
            usage: result.usage,
            errorCode: ERROR_CODES.AI_OUTPUT_SCHEMA_INVALID,
            errorMessage: lastError.message,
          });
          if (regenerations >= this.env.NVIDIA_MAX_SCHEMA_REGENERATIONS) break;
          messages = withCorrection(options.messages, '你上次的輸出不是合法的 JSON。請只輸出 JSON。');
          regenerations += 1;
          attemptIndex += 1;
          continue;
        }

        const validated = options.responseSchema.safeParse(parsed);
        if (!validated.success) {
          const issues = validated.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('；');

          // 分辨「結構不符」與「語意矛盾」——後者是實測踩過的狀況，
          // 分開記錄才能事後知道模型到底在哪一層出錯。
          const status: RequestStatus = issues.includes('Required') ? 'schema_invalid' : 'semantic_invalid';
          lastError = new Error(issues);

          await this.log(options, {
            status,
            latencyMs,
            attemptIndex,
            retryCount: transportRetries,
            finishReason: result.finishReason,
            httpStatus: result.httpStatus,
            usage: result.usage,
            errorCode:
              status === 'schema_invalid'
                ? ERROR_CODES.AI_OUTPUT_SCHEMA_INVALID
                : ERROR_CODES.AI_OUTPUT_SEMANTIC_INVALID,
            errorMessage: issues.slice(0, 1000),
          });

          if (regenerations >= this.env.NVIDIA_MAX_SCHEMA_REGENERATIONS) break;
          messages = withCorrection(
            options.messages,
            `你上次的輸出未通過驗證，請修正後重新輸出：${issues}`,
          );
          regenerations += 1;
          attemptIndex += 1;
          continue;
        }

        await this.log(options, {
          status: 'success',
          latencyMs,
          attemptIndex,
          retryCount: transportRetries,
          finishReason: result.finishReason,
          httpStatus: result.httpStatus,
          usage: result.usage,
        });

        return { data: validated.data, raw: parsed, model: result.model };
      } catch (error) {
        const latencyMs = Date.now() - startedAt;

        if (!(error instanceof AiProviderError)) throw error;
        lastError = error;

        await this.log(options, {
          status: providerErrorStatus(error),
          latencyMs,
          attemptIndex,
          retryCount: transportRetries,
          httpStatus: error.httpStatus ?? undefined,
          errorCode: providerErrorCode(error),
          errorMessage: error.message.slice(0, 1000),
        });

        // 參數錯誤重試幾次結果都一樣，立即失敗才能讓問題浮出來。
        if (error.kind === 'bad_request') {
          throw new AppException(
            ERROR_CODES.AI_PROVIDER_UNAVAILABLE,
            'AI 服務拒絕了這次請求，請檢查伺服器記錄。',
          );
        }

        const maxRetries =
          error.kind === 'rate_limited'
            ? this.env.NVIDIA_MAX_RETRIES_429
            : this.env.NVIDIA_MAX_RETRIES_5XX;

        if (transportRetries >= maxRetries) break;

        const backoff = error.retryAfterMs ?? 2 ** transportRetries * 1000;
        transportRetries += 1;
        attemptIndex += 1;
        await sleep(backoff + jitter());
        continue;
      }
    }

    this.logger.error(`AI 呼叫 ${options.operation} 最終失敗：${lastError?.message ?? '未知原因'}`);
    throw new AppException(
      lastError?.message.includes('未通過驗證') || lastError?.message.includes('JSON')
        ? ERROR_CODES.AI_OUTPUT_SCHEMA_INVALID
        : ERROR_CODES.AI_PROVIDER_UNAVAILABLE,
      `AI 分析失敗：${lastError?.message.slice(0, 300) ?? '未知原因'}`,
    );
  }

  /** JSON Schema 轉換有成本且結果固定，快取起來避免每次呼叫重算。 */
  private jsonSchemaFor(operation: AiOperation, zodSchema: ZodTypeAny): Record<string, unknown> {
    const cached = this.schemaCache.get(operation);
    if (cached) return cached;
    const generated = toStrictJsonSchema(zodSchema, operation);
    this.schemaCache.set(operation, generated);
    return generated;
  }

  private async log(
    options: AiCallOptions<ZodTypeAny>,
    entry: {
      status: RequestStatus;
      latencyMs: number;
      attemptIndex: number;
      retryCount: number;
      httpStatus?: number;
      finishReason?: string | null;
      usage?: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
      errorCode?: string;
      errorMessage?: string;
    },
  ): Promise<void> {
    try {
      await this.database.db.insert(schema.aiUsageLogs).values({
        aiJobId: options.aiJobId ?? null,
        userId: options.userId,
        operation: options.operation,
        model: this.provider.model,
        promptVersion: options.promptVersion ?? null,
        requestStatus: entry.status,
        httpStatus: entry.httpStatus ?? null,
        latencyMs: entry.latencyMs,
        inputTokens: entry.usage?.inputTokens ?? null,
        outputTokens: entry.usage?.outputTokens ?? null,
        totalTokens: entry.usage?.totalTokens ?? null,
        reasoningEffort: options.reasoningEffort,
        finishReason: entry.finishReason ?? null,
        errorCode: entry.errorCode ?? null,
        errorMessage: entry.errorMessage ?? null,
        retryCount: entry.retryCount,
        attemptIndex: entry.attemptIndex,
      });
    } catch (error) {
      // 用量記錄失敗不該讓分析整個掛掉，但必須留下痕跡。
      this.logger.error(`寫入 ai_usage_logs 失敗：${describe(error)}`);
    }
  }
}

function providerErrorStatus(error: AiProviderError): RequestStatus {
  if (error.kind === 'rate_limited') return 'rate_limited';
  if (error.kind === 'timeout') return 'timeout';
  return 'http_error';
}

function providerErrorCode(error: AiProviderError): string {
  return error.kind === 'rate_limited'
    ? ERROR_CODES.AI_PROVIDER_RATE_LIMITED
    : ERROR_CODES.AI_PROVIDER_UNAVAILABLE;
}

/** 把修正指示接在原始訊息後面，而不是取代 —— 模型仍需要完整的原始輸入。 */
function withCorrection(messages: AiChatMessage[], correction: string): AiChatMessage[] {
  return [...messages, { role: 'user', content: correction }];
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 加入隨機抖動，避免多個重試在同一刻一起打過去。 */
function jitter(): number {
  return Math.floor(Math.random() * 500);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
