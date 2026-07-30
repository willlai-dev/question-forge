import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  commitImportSchema,
  ERROR_CODES,
  fixImportQuestionSchema,
  importBatchResponseSchema,
  importQuestionResponseSchema,
  uuidSchema,
  type CommitImportResult,
  type Env,
  type ImportBatchResponse,
  type ImportQuestionResponse,
} from '@repo/contracts';
import { createZodDto, ZodValidationPipe } from 'nestjs-zod';

import { AppException } from '../../common/app.exception';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators';
import { ENV } from '../../config/env.config';
import { ImportsService } from './imports.service';

export class CommitImportDto extends createZodDto(commitImportSchema) {}
export class FixImportQuestionDto extends createZodDto(fixImportQuestionSchema) {}
export class ImportBatchResponseDto extends createZodDto(importBatchResponseSchema) {}
export class ImportQuestionResponseDto extends createZodDto(importQuestionResponseSchema) {}

/** 從 repo 根目錄的 docs/ 讀取匯入格式與 Prompt，讓文件與 API 只有一份來源。 */
function readDoc(filename: string): string {
  let current = __dirname;
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = resolve(current, 'docs', filename);
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new AppException(ERROR_CODES.INTERNAL_ERROR, `找不到文件檔案 ${filename}。`);
}

@ApiTags('imports')
@Controller('imports')
export class ImportsController {
  constructor(
    private readonly importsService: ImportsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('schema')
  @ApiOperation({ summary: '取得題庫匯入 JSON Schema' })
  getSchema(): unknown {
    return JSON.parse(readDoc('QUESTION_IMPORT_SCHEMA.json'));
  }

  @Get('prompt')
  @ApiOperation({
    summary: '取得 PDF 整理 Prompt',
    description: '複製這段文字連同 PDF 交給具備 PDF 閱讀能力的外部 LLM。',
  })
  getPrompt(): { prompt: string } {
    const markdown = readDoc('QUESTION_IMPORT_PROMPT.md');
    // 只取「Prompt 本文」的程式碼區塊，避免使用者連說明一起複製。
    const match = /```text\n([\s\S]*?)\n```/.exec(markdown);
    return { prompt: match?.[1] ?? markdown };
  }

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
  })
  @ApiOperation({
    summary: '上傳題庫 JSON',
    description:
      '上傳後只寫入暫存區並產生逐題驗證結果，正式題庫在確認 commit 前完全不會被寫入。',
  })
  @ApiOkResponse({ type: ImportBatchResponseDto })
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<ImportBatchResponse> {
    // 刻意不用 Nest 的 FileTypeValidator：它預設會做 magic number 檢查，
    // 而 JSON 是純文字、沒有 magic bytes，合法檔案反而會被擋下。
    // 內容是否為合法 JSON 由 service 解析時判定，錯誤訊息也更具體。
    if (!file) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, '請選擇要上傳的 JSON 檔案。');
    }

    if (file.size > this.env.IMPORT_MAX_FILE_SIZE_BYTES) {
      throw new AppException(
        ERROR_CODES.PAYLOAD_TOO_LARGE,
        `檔案大小超過上限 ${this.env.IMPORT_MAX_FILE_SIZE_BYTES} bytes。`,
      );
    }

    const allowedTypes = ['application/json', 'text/plain', 'application/octet-stream'];
    if (file.mimetype && !allowedTypes.includes(file.mimetype)) {
      throw new AppException(
        ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
        `不支援的檔案型別「${file.mimetype}」，請上傳 JSON 檔案。`,
      );
    }

    return this.importsService.createBatch(user.id, file);
  }

  @Get()
  @ApiOperation({ summary: '列出匯入批次' })
  @ApiOkResponse({ type: ImportBatchResponseDto, isArray: true })
  list(@CurrentUser() user: AuthenticatedUser): Promise<ImportBatchResponse[]> {
    return this.importsService.listBatches(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: '取得匯入批次摘要' })
  @ApiOkResponse({ type: ImportBatchResponseDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<ImportBatchResponse> {
    return this.importsService.getBatch(user.id, id);
  }

  @Get(':id/questions')
  @ApiOperation({
    summary: '列出暫存題目與其驗證問題',
    description: '可用 status 篩選：valid / warning / error / excluded / committed。',
  })
  @ApiOkResponse({ type: ImportQuestionResponseDto, isArray: true })
  listQuestions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Query('status') status?: string,
  ): Promise<ImportQuestionResponse[]> {
    return this.importsService.listBatchQuestions(user.id, id, status);
  }

  @Patch(':id/questions/:importQuestionId')
  @ApiOperation({ summary: '修正暫存題目', description: '修正後會自動重新驗證整批。' })
  @ApiOkResponse({ type: ImportBatchResponseDto })
  fix(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('importQuestionId', new ZodValidationPipe(uuidSchema)) importQuestionId: string,
    @Body() dto: FixImportQuestionDto,
  ): Promise<ImportBatchResponse> {
    return this.importsService.fixQuestion(user.id, id, importQuestionId, dto);
  }

  @Post(':id/questions/:importQuestionId/exclude')
  @HttpCode(200)
  @ApiOperation({ summary: '排除暫存題目', description: '排除後不會寫入正式題庫。' })
  @ApiOkResponse({ type: ImportBatchResponseDto })
  exclude(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('importQuestionId', new ZodValidationPipe(uuidSchema)) importQuestionId: string,
  ): Promise<ImportBatchResponse> {
    return this.importsService.excludeQuestion(user.id, id, importQuestionId);
  }

  @Post(':id/revalidate')
  @HttpCode(200)
  @ApiOperation({ summary: '重新驗證整批' })
  @ApiOkResponse({ type: ImportBatchResponseDto })
  revalidate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<ImportBatchResponse> {
    return this.importsService.revalidate(user.id, id);
  }

  @Post(':id/commit')
  @HttpCode(200)
  @ApiOperation({
    summary: '確認匯入，寫入正式題庫',
    description:
      '只會寫入 valid / warning / fixed 狀態的題目；有阻斷性錯誤時回 400 IMPORT_HAS_BLOCKING_ERRORS。',
  })
  commit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body() dto: CommitImportDto,
  ): Promise<CommitImportResult> {
    return this.importsService.commit(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: '丟棄匯入批次' })
  async discard(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ ok: true }> {
    await this.importsService.discard(user.id, id);
    return { ok: true };
  }
}
