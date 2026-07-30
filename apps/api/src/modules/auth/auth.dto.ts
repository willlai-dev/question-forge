import {
  bootstrapRequestSchema,
  bootstrapStatusSchema,
  csrfTokenResponseSchema,
  loginRequestSchema,
  userResponseSchema,
} from '@repo/contracts';
import { createZodDto } from 'nestjs-zod';

/**
 * 以 createZodDto 把共用的 Zod schema 包成 NestJS DTO 類別。
 * 同一份 schema 因此同時負責：request 驗證、TypeScript 型別、OpenAPI 文件。
 */
export class BootstrapDto extends createZodDto(bootstrapRequestSchema) {}
export class BootstrapStatusDto extends createZodDto(bootstrapStatusSchema) {}
export class LoginDto extends createZodDto(loginRequestSchema) {}
export class UserResponseDto extends createZodDto(userResponseSchema) {}
export class CsrfTokenResponseDto extends createZodDto(csrfTokenResponseSchema) {}
