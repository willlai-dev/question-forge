import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  aggregateAnalysisResponseSchema,
  aiJobResponseSchema,
  analyzeAggregateSchema,
  analyzeQuestionSchema,
  answerConflictResponseSchema,
  aiUsageResponseSchema,
  listAiJobsQuerySchema,
  listConflictsQuerySchema,
  paginated,
  questionAnalysisResponseSchema,
  resolveConflictSchema,
  uuidSchema,
  type AggregateAnalysisResponse,
  type AiJobResponse,
  type AiUsageResponse,
  type AnswerConflictResponse,
  type PaginationMeta,
  type PromptVersionResponse,
  type QuestionAnalysisResponse,
} from '@repo/contracts';
import { createZodDto, ZodValidationPipe } from 'nestjs-zod';

import { CurrentUser, type AuthenticatedUser } from '../../common/decorators';
import { AggregateAnalysisService } from './aggregate-analysis.service';
import { AiJobsService } from './ai-jobs.service';
import { AnalysisReadService } from './analysis-read.service';
import { ConflictsService } from './conflicts.service';

export class AnalyzeQuestionDto extends createZodDto(analyzeQuestionSchema) {}
export class AnalyzeAggregateDto extends createZodDto(analyzeAggregateSchema) {}
export class AggregateAnalysisResponseDto extends createZodDto(aggregateAnalysisResponseSchema) {}
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

  @Get('prompt-versions')
  @ApiOperation({
    summary: 'Prompt 版本清單',
    description:
      '**唯讀。** 版本由程式碼決定：prompt 內容進版控，啟動時 seed 進資料庫，' +
      '改 prompt 就要改版號。此處不提供切換啟用版本——' +
      'prompt 版本是 AI 快取鍵的一部分，切換等於讓既有解析全部失效並需要重新分析。' +
      '也不回傳 prompt 內文：那是注入面的內容，沒有顯示的必要。',
  })
  promptVersions(): Promise<PromptVersionResponse[]> {
    return this.analysis.promptVersions();
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

/**
 * 多題整合分析（規格 §11）。
 *
 * 分析本身是非同步任務（一次模型呼叫仍可能數十秒），因此 POST 只回 jobId，
 * 前端輪詢 `GET /ai/jobs/:id` 取得進度，完成後再讀這裡的結果。
 */
@ApiTags('ai')
@Controller('ai/aggregate-analyses')
export class AggregateAnalysesController {
  constructor(
    private readonly jobs: AiJobsService,
    private readonly aggregate: AggregateAnalysisService,
  ) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({
    summary: '啟動多題整合分析',
    description:
      '先由 PostgreSQL 完成統計、挑出最多 15 題代表錯題，才送模型（規格 §11）。' +
      '省略 from／to 時預設分析最近 30 天。',
  })
  @ApiOkResponse({ type: AiJobResponseDto })
  analyze(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AnalyzeAggregateDto,
  ): Promise<AiJobResponse> {
    return this.jobs.analyzeAggregate(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: '歷次整合分析（新到舊）' })
  list(@CurrentUser() user: AuthenticatedUser): Promise<AggregateAnalysisResponse[]> {
    return this.aggregate.list(user.id, 20);
  }

  @Get('latest')
  @ApiOperation({
    summary: '最近一次整合分析',
    description: '尚未產生過任何分析時回傳 null，而不是 404 —— 這是正常的初始狀態。',
  })
  latest(@CurrentUser() user: AuthenticatedUser): Promise<AggregateAnalysisResponse | null> {
    return this.aggregate.latest(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: '單筆整合分析（含統計快照）' })
  @ApiOkResponse({ type: AggregateAnalysisResponseDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<AggregateAnalysisResponse> {
    return this.aggregate.get(user.id, id);
  }
}
