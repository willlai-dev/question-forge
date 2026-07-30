import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  bulkQuestionActionSchema,
  createQuestionSchema,
  listQuestionsQuerySchema,
  paginated,
  questionResponseSchema,
  questionVersionResponseSchema,
  updateQuestionSchema,
  uuidSchema,
  type PaginationMeta,
  type QuestionResponse,
  type QuestionVersionResponse,
} from '@repo/contracts';
import { createZodDto, ZodValidationPipe } from 'nestjs-zod';

import { CurrentUser, type AuthenticatedUser } from '../../common/decorators';
import { QuestionsService } from './questions.service';

export class CreateQuestionDto extends createZodDto(createQuestionSchema) {}
export class UpdateQuestionDto extends createZodDto(updateQuestionSchema) {}
export class ListQuestionsQueryDto extends createZodDto(listQuestionsQuerySchema) {}
export class BulkQuestionActionDto extends createZodDto(bulkQuestionActionSchema) {}
export class QuestionResponseDto extends createZodDto(questionResponseSchema) {}
export class QuestionListResponseDto extends createZodDto(paginated(questionResponseSchema)) {}
export class QuestionVersionResponseDto extends createZodDto(questionVersionResponseSchema) {}

@ApiTags('questions')
@Controller('questions')
export class QuestionsController {
  constructor(private readonly questionsService: QuestionsService) {}

  @Get()
  @ApiOperation({
    summary: '列出題目',
    description:
      '支援關鍵字、科目、章節（傳 none 表示無章節）、題組、題型、狀態、' +
      'reviewRequired 與 hasExplanation 篩選，以及分頁與排序。',
  })
  @ApiOkResponse({ type: QuestionListResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListQuestionsQueryDto,
  ): Promise<{ items: QuestionResponse[]; pagination: PaginationMeta }> {
    return this.questionsService.list(user.id, query);
  }

  @Post()
  @ApiOperation({
    summary: '建立題目',
    description:
      '單選題必須恰好一個正確答案，複選題至少兩個。' +
      'explanation 可為 null —— 系統不會自動產生解析。',
  })
  @ApiOkResponse({ type: QuestionResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateQuestionDto,
  ): Promise<QuestionResponse> {
    return this.questionsService.create(user.id, dto);
  }

  @Post('bulk')
  @HttpCode(200)
  @ApiOperation({
    summary: '批次操作',
    description: 'move（移動題組，會一併維護反正規化欄位）、delete、setReviewRequired。',
  })
  bulk(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkQuestionActionDto,
  ): Promise<{ affected: number }> {
    return this.questionsService.bulk(user.id, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: '取得單一題目（含選項）' })
  @ApiOkResponse({ type: QuestionResponseDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<QuestionResponse> {
    return this.questionsService.getOrThrow(user.id, id);
  }

  @Get(':id/versions')
  @ApiOperation({ summary: '題目版本歷史', description: '每次更新都會寫入一筆快照。' })
  @ApiOkResponse({ type: QuestionVersionResponseDto, isArray: true })
  versions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<QuestionVersionResponse[]> {
    return this.questionsService.versions(user.id, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: '更新題目',
    description: '會寫入版本快照並重新計算 contentHash（AI 快取失效的判準）。',
  })
  @ApiOkResponse({ type: QuestionResponseDto })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body() dto: UpdateQuestionDto,
  ): Promise<QuestionResponse> {
    return this.questionsService.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: '刪除題目', description: '軟刪除，歷史作答紀錄不受影響。' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ ok: true }> {
    await this.questionsService.remove(user.id, id);
    return { ok: true };
  }
}
