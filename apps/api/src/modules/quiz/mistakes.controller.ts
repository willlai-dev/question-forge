import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  mistakeResponseSchema,
  paginated,
  uuidSchema,
  type CreateMistakePracticeRequest,
  type MistakeDetailResponse,
  type MistakeResponse,
  type MistakeStatsResponse,
  type PaginationMeta,
  type QuizSessionResponse,
} from '@repo/contracts';
import { createZodDto, ZodValidationPipe } from 'nestjs-zod';

import { CurrentUser, type AuthenticatedUser } from '../../common/decorators';
import { MistakesService } from './mistakes.service';
import {
  CreateMistakePracticeDto,
  ListMistakesQueryDto,
  MistakeDetailResponseDto,
  MistakeStatsResponseDto,
  QuizSessionResponseDto,
} from './quiz.dto';

export class MistakeListResponseDto extends createZodDto(paginated(mistakeResponseSchema)) {}

@ApiTags('mistakes')
@Controller('mistakes')
export class MistakesController {
  constructor(private readonly mistakes: MistakesService) {}

  @Get()
  @ApiOperation({
    summary: '列出錯題',
    description:
      '答對一次不會刪除紀錄（FR-MIS-05），只會改變 masteryState；' +
      '因此本資源沒有刪除端點。',
  })
  @ApiOkResponse({ type: MistakeListResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListMistakesQueryDto,
  ): Promise<{ items: MistakeResponse[]; pagination: PaginationMeta }> {
    return this.mistakes.list(user.id, query);
  }

  @Get('stats')
  @ApiOperation({ summary: '錯題統計摘要' })
  @ApiOkResponse({ type: MistakeStatsResponseDto })
  stats(@CurrentUser() user: AuthenticatedUser): Promise<MistakeStatsResponse> {
    return this.mistakes.stats(user.id);
  }

  @Post('practice')
  @HttpCode(200)
  @ApiOperation({
    summary: '由錯題建立重練場次',
    description: '等同於以 onlyMistakes = true 建立場次，mode 固定為 mistake_review。',
  })
  @ApiOkResponse({ type: QuizSessionResponseDto })
  practice(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMistakePracticeDto,
  ): Promise<QuizSessionResponse> {
    return this.mistakes.createPractice(user.id, dto as CreateMistakePracticeRequest);
  }

  @Get(':questionId')
  @ApiOperation({ summary: '單題錯題詳情', description: '包含歷次作答紀錄。' })
  @ApiOkResponse({ type: MistakeDetailResponseDto })
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('questionId', new ZodValidationPipe(uuidSchema)) questionId: string,
  ): Promise<MistakeDetailResponse> {
    return this.mistakes.detail(user.id, questionId);
  }
}
