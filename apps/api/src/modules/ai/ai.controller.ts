import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  aiJobResponseSchema,
  analyzeQuestionSchema,
  answerConflictResponseSchema,
  aiUsageResponseSchema,
  listAiJobsQuerySchema,
  listConflictsQuerySchema,
  paginated,
  questionAnalysisResponseSchema,
  resolveConflictSchema,
  uuidSchema,
  type AiJobResponse,
  type AiUsageResponse,
  type AnswerConflictResponse,
  type PaginationMeta,
  type QuestionAnalysisResponse,
} from '@repo/contracts';
import { createZodDto, ZodValidationPipe } from 'nestjs-zod';

import { CurrentUser, type AuthenticatedUser } from '../../common/decorators';
import { AiJobsService } from './ai-jobs.service';
import { AnalysisReadService } from './analysis-read.service';
import { ConflictsService } from './conflicts.service';

export class AnalyzeQuestionDto extends createZodDto(analyzeQuestionSchema) {}
export class ListAiJobsQueryDto extends createZodDto(listAiJobsQuerySchema) {}
export class ListConflictsQueryDto extends createZodDto(listConflictsQuerySchema) {}
export class ResolveConflictDto extends createZodDto(resolveConflictSchema) {}
export class AiJobResponseDto extends createZodDto(aiJobResponseSchema) {}
export class AiJobListResponseDto extends createZodDto(paginated(aiJobResponseSchema)) {}
export class QuestionAnalysisResponseDto extends createZodDto(questionAnalysisResponseSchema) {}
export class AnswerConflictResponseDto extends createZodDto(answerConflictResponseSchema) {}
export class ConflictListResponseDto extends createZodDto(paginated(answerConflictResponseSchema)) {}
export class AiUsageResponseDto extends createZodDto(aiUsageResponseSchema) {}

@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(
    private readonly jobs: AiJobsService,
    private readonly analysis: AnalysisReadService,
  ) {}

  @Post('questions/:questionId/analyze')
  @HttpCode(202)
  @ApiOperation({
    summary: '啟動單題 AI 分析',
    description:
      '非同步執行，只回傳 jobId，請以 GET /ai/jobs/:id 輪詢進度。' +
      '內容未變且 prompt／模型版本相同時會直接命中快取，完全不呼叫模型；' +
      '帶 force=true 可強制重新分析。',
  })
  @ApiOkResponse({ type: AiJobResponseDto })
  analyze(
    @CurrentUser() user: AuthenticatedUser,
    @Param('questionId', new ZodValidationPipe(uuidSchema)) questionId: string,
    @Body() dto: AnalyzeQuestionDto,
  ): Promise<AiJobResponse> {
    return this.jobs.analyzeQuestion(user.id, questionId, dto);
  }

  @Get('jobs')
  @ApiOperation({ summary: '列出 AI 任務' })
  @ApiOkResponse({ type: AiJobListResponseDto })
  listJobs(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListAiJobsQueryDto,
  ): Promise<{ items: AiJobResponse[]; pagination: PaginationMeta }> {
    return this.jobs.list(user.id, query);
  }

  @Get('jobs/:id')
  @ApiOperation({ summary: '查詢任務進度', description: '前端每 1.5 秒輪詢一次。' })
  @ApiOkResponse({ type: AiJobResponseDto })
  getJob(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<AiJobResponse> {
    return this.jobs.get(user.id, id);
  }

  @Post('jobs/:id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: '取消任務', description: '已在執行中的階段無法中斷，但不會再往下走。' })
  @ApiOkResponse({ type: AiJobResponseDto })
  cancelJob(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<AiJobResponse> {
    return this.jobs.cancel(user.id, id);
  }

  @Post('jobs/:id/retry')
  @HttpCode(200)
  @ApiOperation({ summary: '重跑失敗的任務' })
  @ApiOkResponse({ type: AiJobResponseDto })
  retryJob(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<AiJobResponse> {
    return this.jobs.retry(user.id, id);
  }

  @Get('usage')
  @ApiOperation({ summary: 'AI 用量統計', description: '呼叫次數、token 用量、延遲分布、失敗率。' })
  @ApiOkResponse({ type: AiUsageResponseDto })
  usage(@CurrentUser() user: AuthenticatedUser): Promise<AiUsageResponse> {
    return this.analysis.usage(user.id);
  }
}

@ApiTags('ai')
@Controller('questions/:questionId/analysis')
export class QuestionAnalysisController {
  constructor(private readonly analysis: AnalysisReadService) {}

  @Get()
  @ApiOperation({
    summary: '取得題目的 AI 解析',
    description: 'isStale 為 true 代表題目在產生解析之後被修改過，內容不一定還適用。',
  })
  @ApiOkResponse({ type: QuestionAnalysisResponseDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('questionId', new ZodValidationPipe(uuidSchema)) questionId: string,
    @Query('userAnswerId') userAnswerId?: string,
  ): Promise<QuestionAnalysisResponse> {
    return this.analysis.getQuestionAnalysis(user.id, questionId, userAnswerId ?? null);
  }
}

@ApiTags('ai')
@Controller('answer-conflicts')
export class AnswerConflictsController {
  constructor(private readonly conflicts: ConflictsService) {}

  @Get()
  @ApiOperation({
    summary: '列出答案爭議',
    description: 'AI 認為題庫答案可能有誤時建立，絕不自動修改答案。',
  })
  @ApiOkResponse({ type: ConflictListResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListConflictsQueryDto,
  ): Promise<{ items: AnswerConflictResponse[]; pagination: PaginationMeta }> {
    return this.conflicts.list(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: '取得單筆爭議' })
  @ApiOkResponse({ type: AnswerConflictResponseDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<AnswerConflictResponse> {
    return this.conflicts.get(user.id, id);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @ApiOperation({
    summary: '裁決爭議',
    description:
      '五種決策：維持原答案／修改答案／更新解析／標記爭議／排除題目。' +
      '修改答案是唯一會改動題庫的路徑，且只能由人指定新答案。',
  })
  @ApiOkResponse({ type: AnswerConflictResponseDto })
  resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body() dto: ResolveConflictDto,
  ): Promise<AnswerConflictResponse> {
    return this.conflicts.resolve(user.id, id, dto);
  }
}
