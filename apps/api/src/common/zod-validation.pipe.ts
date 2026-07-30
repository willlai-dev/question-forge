import { createZodValidationPipe } from 'nestjs-zod';

/**
 * 全域 Zod 驗證管道。
 *
 * 刻意讓它拋出原始的 ZodError，而不是 nestjs-zod 預設的 ZodValidationException ——
 * AllExceptionsFilter 已經知道如何把 ZodError 轉成本專案的統一錯誤格式
 * （VALIDATION_FAILED + 逐欄位 details），驗證錯誤的呈現因此只有一個來源。
 */
export const AppZodValidationPipe = createZodValidationPipe({
  // nestjs-zod 這裡傳入的一定是 ZodError（本身就是 Error 的子類），
  // 但其型別簽章為 unknown，故做一次收斂而非型別斷言。
  createValidationException: (error: unknown) =>
    error instanceof Error ? error : new Error('請求內容未通過驗證。'),
});
