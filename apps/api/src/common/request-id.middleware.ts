import { randomUUID } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * 帶有追蹤 ID 的請求。
 *
 * 刻意用明確型別而非 `declare module 'express-serve-static-core'` 做型別擴充：
 * pnpm 的嚴格 node_modules 結構下，該模組不是直接相依，型別擴充無法穩定解析。
 */
export interface RequestWithId extends Request {
  requestId?: string;
}

/**
 * 為每個請求產生追蹤 ID，並回寫到回應標頭。
 * 統一錯誤格式中的 requestId 即來自這裡，方便把使用者回報的錯誤對回後端 log。
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: RequestWithId, res: Response, next: NextFunction): void {
    const incoming = req.header(REQUEST_ID_HEADER);
    // 外部傳入的值不可信，長度與字元都要限制後才採用。
    const requestId =
      incoming && /^[A-Za-z0-9_-]{1,64}$/.test(incoming) ? incoming : randomUUID();

    req.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  }
}
