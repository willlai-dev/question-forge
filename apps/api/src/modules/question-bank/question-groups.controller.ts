import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  uuidSchema,
  type PaginationMeta,
  type QuestionGroupResponse,
} from '@repo/contracts';
import { ZodValidationPipe } from 'nestjs-zod';

import { CurrentUser, type AuthenticatedUser } from '../../common/decorators';
import {
  CreateQuestionGroupDto,
  ListQuestionGroupsQueryDto,
  QuestionGroupListResponseDto,
  QuestionGroupResponseDto,
  ReorderDto,
  UpdateQuestionGroupDto,
} from './question-bank.dto';
import { QuestionGroupsService } from './question-groups.service';

@ApiTags('question-groups')
@Controller('question-groups')
export class QuestionGroupsController {
  constructor(private readonly questionGroupsService: QuestionGroupsService) {}

  @Get()
  @ApiOperation({
    summary: '列出題組',
    description: 'chapterId 傳 "none" 可只查詢沒有章節、直接隸屬科目的題組。',
  })
  @ApiOkResponse({ type: QuestionGroupListResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListQuestionGroupsQueryDto,
  ): Promise<{ items: QuestionGroupResponse[]; pagination: PaginationMeta }> {
    return this.questionGroupsService.list(user.id, query);
  }

  @Post()
  @ApiOperation({ summary: '建立題組', description: 'chapterId 可為 null，代表直接隸屬科目。' })
  @ApiOkResponse({ type: QuestionGroupResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateQuestionGroupDto,
  ): Promise<QuestionGroupResponse> {
    return this.questionGroupsService.create(user.id, dto);
  }

  @Post('reorder')
  @ApiOperation({ summary: '重新排序題組' })
  async reorder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReorderDto,
  ): Promise<{ ok: true }> {
    await this.questionGroupsService.reorder(user.id, dto.orderedIds);
    return { ok: true };
  }

  @Get(':id')
  @ApiOperation({ summary: '取得單一題組' })
  @ApiOkResponse({ type: QuestionGroupResponseDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<QuestionGroupResponse> {
    return this.questionGroupsService.findByIdOrThrow(user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新題組' })
  @ApiOkResponse({ type: QuestionGroupResponseDto })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body() dto: UpdateQuestionGroupDto,
  ): Promise<QuestionGroupResponse> {
    return this.questionGroupsService.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary: '刪除題組',
    description: '軟刪除，並連帶軟刪除其題目（題目不能沒有題組）。歷史作答紀錄不受影響。',
  })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ ok: true }> {
    await this.questionGroupsService.remove(user.id, id);
    return { ok: true };
  }
}
