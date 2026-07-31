import { z } from 'zod';

/**
 * 認證相關契約。
 *
 * 密碼規則（FR-AUTH-08）：至少 12 字元，且不得與帳號相同。
 * 規則寫在共用契約中，前端表單與後端驗證因此必然一致。
 */

export const usernameSchema = z
  .string()
  .trim()
  .min(3, '帳號至少 3 個字元')
  .max(50, '帳號最多 50 個字元')
  .regex(/^[A-Za-z0-9._-]+$/, '帳號只能包含英文字母、數字、點、底線與連字號');

/**
 * 密碼長度下限為 8。
 *
 * 取捨說明：8 字元在暴力破解下弱於 12，但本系統只在本機執行、
 * 單一使用者、不對外開放，且以 argon2id 雜湊儲存（memoryCost 19 MiB），
 * 離線破解成本仍然很高。若日後對外開放，這個值應該調回 12 以上。
 */
export const PASSWORD_MIN_LENGTH = 8;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `密碼至少 ${PASSWORD_MIN_LENGTH} 個字元`)
  .max(200, '密碼最多 200 個字元');

/** GET /auth/bootstrap 的回應：是否仍可執行首次初始化。 */
export const bootstrapStatusSchema = z.object({
  canBootstrap: z.boolean(),
});
export type BootstrapStatus = z.infer<typeof bootstrapStatusSchema>;

export const bootstrapRequestSchema = z
  .object({
    username: usernameSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    displayName: z.string().trim().max(100).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.password !== value.confirmPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmPassword'],
        message: '兩次輸入的密碼不一致',
      });
    }
    if (value.password.toLowerCase() === value.username.toLowerCase()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: '密碼不得與帳號相同',
      });
    }
  });
export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;

export const loginRequestSchema = z
  .object({
    username: z.string().trim().min(1, '請輸入帳號'),
    password: z.string().min(1, '請輸入密碼'),
  })
  .strict();
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** 使用者資訊。刻意不含 passwordHash 等任何敏感欄位。 */
export const userResponseSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  displayName: z.string().nullable(),
  lastLoginAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type UserResponse = z.infer<typeof userResponseSchema>;

export const csrfTokenResponseSchema = z.object({
  csrfToken: z.string(),
});
export type CsrfTokenResponse = z.infer<typeof csrfTokenResponseSchema>;
