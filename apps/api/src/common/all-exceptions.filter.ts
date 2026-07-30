import { randomUUID } from 'node:crypto';

import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ERROR_CODES, type ApiError, type ErrorDetail } from '@repo/contracts';
import type { Response } from 'express';
import { ZodError } from 'zod';

import type { RequestWithId } from './request-id.middleware';

/**
 * 全域例外處理：把所有錯誤轉成 prompt.md §二要求的統一格式。
 *
 * 安全考量：
 *   - 5xx 一律回傳固定訊息，不把內部錯誤細節（可能含連線字串、外部 API 回應）送到前端。
 *   - 完整堆疊只寫入伺服器 log，並附上 requestId 供對照。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<RequestWithId>();
    const response = ctx.getResponse<Response>();
    const requestId = request.requestId ?? randomUUID();

    const { status, code, message, details } = this.normalize(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${requestId}] ${request.method} ${request.originalUrl} -> ${status} ${code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`[${requestId}] ${request.method} ${request.originalUrl} -> ${status} ${code}`);
    }

    const body: ApiError = {
      error: {
        code,
        message,
        ...(details && details.length > 0 ? { details } : {}),
        requestId,
        timestamp: new Date().toISOString(),
      },
    };

    response.status(status).json(body);
  }

  private normalize(exception: unknown): {
    status: number;
    code: string;
    message: string;
    details?: ErrorDetail[];
  } {
    // Zod 驗證錯誤 -> 400 VALIDATION_FAILED，逐欄位列出問題。
    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: '請求內容未通過驗證。',
        details: exception.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      // AppException 會塞入 { code, message, details }
      if (typeof payload === 'object' && payload !== null && 'code' in payload) {
        const typed = payload as { code: string; message?: string; details?: ErrorDetail[] };
        return {
          status,
          code: typed.code,
          message: typed.message ?? exception.message,
          details: typed.details,
        };
      }

      // Nest 內建例外（NotFoundException 等）
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] }).message ?? exception.message);

      return {
        status,
        code: this.fallbackCodeForStatus(status),
        message: Array.isArray(message) ? message.join('; ') : message,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ERROR_CODES.INTERNAL_ERROR,
      // 刻意不回傳原始錯誤訊息，避免洩漏內部細節。
      message: '伺服器發生未預期的錯誤，請稍後再試。',
    };
  }

  private fallbackCodeForStatus(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ERROR_CODES.VALIDATION_FAILED;
      case HttpStatus.UNAUTHORIZED:
        return ERROR_CODES.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ERROR_CODES.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ERROR_CODES.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ERROR_CODES.CONFLICT;
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return ERROR_CODES.PAYLOAD_TOO_LARGE;
      case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
        return ERROR_CODES.UNSUPPORTED_MEDIA_TYPE;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ERROR_CODES.RATE_LIMITED;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ERROR_CODES.DEPENDENCY_UNAVAILABLE;
      default:
        return ERROR_CODES.INTERNAL_ERROR;
    }
  }
}
