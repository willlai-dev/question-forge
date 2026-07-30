import { HttpException } from '@nestjs/common';
import { httpStatusForErrorCode, type ErrorCode, type ErrorDetail } from '@repo/contracts';

/**
 * 本專案唯一的業務例外型別。
 *
 * 好處：錯誤碼與 HTTP 狀態碼的對應集中在 @repo/contracts，
 * 前端可以只認 code 而不必解析訊息字串。
 */
export class AppException extends HttpException {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: ErrorDetail[],
  ) {
    super({ code, message, details }, httpStatusForErrorCode(code));
  }
}
