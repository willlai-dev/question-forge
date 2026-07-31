import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  knowledgeTagResponseSchema,
  paginated,
  tagSuggestionResponseSchema,
  uuidSchema,
  type ErrorTypeResponse,
  type KnowledgeTagResponse,
  type PaginationMeta,
  type ResolveTagNameResponse,
  type SkillTagResponse,
  type TagAliasResponse,
  type TagSuggestionResponse,
} from '@repo/contracts';
import { createZodDto, ZodValidationPipe } from 'nestjs-zod';

import { CurrentUser, type AuthenticatedUser } from '../../common/decorators';
import { KnowledgeTagsService } from './knowledge-tags.service';
import { QuestionTagsService, type QuestionTags } from './question-tags.service';
import { TagAliasesService } from './tag-aliases.service';
import { TagSuggestionsService } from './tag-suggestions.service';
import {
  ApproveTagSuggestionDto,
  CreateKnowledgeTagDto,
  CreateSkillTagDto,
  CreateTagAliasDto,
  CreateTagSuggestionDto,
  ErrorTypeResponseDto,
  KnowledgeTagResponseDto,
  ListKnowledgeTagsQueryDto,
  ListTagAliasesQueryDto,
  ListTagSuggestionsQueryDto,
  MergeTagDto,
  MergeTagSuggestionDto,
  RejectTagSuggestionDto,
  ResolveTagNameQueryDto,
  ResolveTagNameResponseDto,
  SetMistakeErrorTypesDto,
  SetQuestionTagsDto,
  SkillTagResponseDto,
  TagAliasResponseDto,
  TagSuggestionResponseDto,
  UpdateErrorTypeDto,
  UpdateKnowledgeTagDto,
  UpdateSkillTagDto,
} from './tags.dto';
import { VocabularyService } from './vocabulary.service';
import { MistakeErrorTypesService } from './mistake-error-types.service';

export class KnowledgeTagListResponseDto extends createZodDto(
  paginated(knowledgeTagResponseSchema),
) {}
export class TagSuggestionListResponseDto extends createZodDto(
  paginated(tagSuggestionResponseSchema),
) {}

@ApiTags('tags')
@Controller('knowledge-tags')
export class KnowledgeTagsController {
  constructor(private readonly tags: KnowledgeTagsService) {}

  @Get()
  @ApiOperation({ summary: '列出知識點', description: '預設不含已合併的標籤。' })
  @ApiOkResponse({ type: KnowledgeTagListResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListKnowledgeTagsQueryDto,
  ): Promise<{ items: KnowledgeTagResponse[]; pagination: PaginationMeta }> {
    return this.tags.list(user.id, query);
  }

  @Post()
  @ApiOperation({ summary: '建立知識點' })
  @ApiOkResponse({ type: KnowledgeTagResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateKnowledgeTagDto,
  ): Promise<KnowledgeTagResponse> {
    return this.tags.create(user.id, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: '取得知識點' })
  @ApiOkResponse({ type: KnowledgeTagResponseDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<KnowledgeTagResponse> {
    return this.tags.getOrThrow(user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新知識點', description: '改名會同步更新用於比對的 slug。' })
  @ApiOkResponse({ type: KnowledgeTagResponseDto })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body() dto: UpdateKnowledgeTagDto,
  ): Promise<KnowledgeTagResponse> {
    return this.tags.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary: '刪除知識點',
    description: '只能刪除完全沒被使用的標籤；已掛在題目上的請改用停用或合併。',
  })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ ok: true }> {
    await this.tags.remove(user.id, id);
    return { ok: true };
  }

  @Post(':id/deprecate')
  @HttpCode(200)
  @ApiOperation({ summary: '停用知識點', description: '既有題目關聯不受影響。' })
  @ApiOkResponse({ type: KnowledgeTagResponseDto })
  deprecate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<KnowledgeTagResponse> {
    return this.tags.deprecate(user.id, id);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @ApiOperation({ summary: '重新啟用知識點' })
  @ApiOkResponse({ type: KnowledgeTagResponseDto })
  activate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<KnowledgeTagResponse> {
    return this.tags.activate(user.id, id);
  }

  @Post(':id/merge')
  @HttpCode(200)
  @ApiOperation({
    summary: '合併知識點',
    description:
      '來源標籤的題目關聯全部轉移到目標，來源改為 merged 並記錄合併目標；' +
      '同時把來源名稱登錄成目標的別名。不刪除任何資料（FR-TAG-10）。',
  })
  @ApiOkResponse({ type: KnowledgeTagResponseDto })
  merge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body() dto: MergeTagDto,
  ): Promise<KnowledgeTagResponse> {
    return this.tags.merge(user.id, id, dto.targetTagId);
  }
}

@ApiTags('tags')
@Controller()
export class VocabularyController {
  constructor(private readonly vocabulary: VocabularyService) {}

  @Get('skill-tags')
  @ApiOperation({ summary: '列出能力類型', description: '系統預設 6 種，可新增。' })
  @ApiOkResponse({ type: SkillTagResponseDto, isArray: true })
  listSkillTags(@Query('includeDeprecated') includeDeprecated?: string): Promise<SkillTagResponse[]> {
    return this.vocabulary.listSkillTags(includeDeprecated === 'true');
  }

  @Post('skill-tags')
  @ApiOperation({ summary: '新增能力類型' })
  @ApiOkResponse({ type: SkillTagResponseDto })
  createSkillTag(@Body() dto: CreateSkillTagDto): Promise<SkillTagResponse> {
    return this.vocabulary.createSkillTag(dto);
  }

  @Patch('skill-tags/:id')
  @ApiOperation({ summary: '更新能力類型', description: '要讓某項退場請把 status 設為 deprecated。' })
  @ApiOkResponse({ type: SkillTagResponseDto })
  updateSkillTag(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body() dto: UpdateSkillTagDto,
  ): Promise<SkillTagResponse> {
    return this.vocabulary.updateSkillTag(id, dto);
  }

  @Get('error-types')
  @ApiOperation({
    summary: '列出錯誤類型',
    description: '系統預設 8 種（含 fallback「無法判定」）。不接受新增與刪除。',
  })
  @ApiOkResponse({ type: ErrorTypeResponseDto, isArray: true })
  listErrorTypes(@Query('includeDeprecated') includeDeprecated?: string): Promise<ErrorTypeResponse[]> {
    return this.vocabulary.listErrorTypes(includeDeprecated === 'true');
  }

  @Patch('error-types/:id')
  @ApiOperation({ summary: '更新錯誤類型', description: 'fallback 項目不可停用。' })
  @ApiOkResponse({ type: ErrorTypeResponseDto })
  updateErrorType(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body() dto: UpdateErrorTypeDto,
  ): Promise<ErrorTypeResponse> {
    return this.vocabulary.updateErrorType(id, dto);
  }
}

@ApiTags('tags')
@Controller('tag-aliases')
export class TagAliasesController {
  constructor(private readonly aliases: TagAliasesService) {}

  @Get()
  @ApiOperation({ summary: '列出別名' })
  @ApiOkResponse({ type: TagAliasResponseDto, isArray: true })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListTagAliasesQueryDto,
  ): Promise<TagAliasResponse[]> {
    return this.aliases.list(user.id, query);
  }

  @Post()
  @ApiOperation({ summary: '建立別名', description: '把相似寫法映射到既有標籤。' })
  @ApiOkResponse({ type: TagAliasResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTagAliasDto,
  ): Promise<TagAliasResponse> {
    return this.aliases.create(user.id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: '刪除別名' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ ok: true }> {
    await this.aliases.remove(user.id, id);
    return { ok: true };
  }
}

@ApiTags('tags')
@Controller('tag-resolve')
export class TagResolveController {
  constructor(private readonly aliases: TagAliasesService) {}

  @Get()
  @ApiOperation({
    summary: '把名稱解析成既有標籤',
    description:
      '先比本名再比別名。matchedTagId 為 null 代表系統中沒有這個標籤，' +
      '唯一的合法後續動作是提交 tag-suggestion（FR-TAG-06）。',
  })
  @ApiOkResponse({ type: ResolveTagNameResponseDto })
  resolve(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ResolveTagNameQueryDto,
  ): Promise<ResolveTagNameResponse> {
    return this.aliases.resolve(user.id, query);
  }
}

@ApiTags('tags')
@Controller('tag-suggestions')
export class TagSuggestionsController {
  constructor(private readonly suggestions: TagSuggestionsService) {}

  @Get()
  @ApiOperation({ summary: '列出標籤建議', description: '重複被建議越多次的排越前面。' })
  @ApiOkResponse({ type: TagSuggestionListResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListTagSuggestionsQueryDto,
  ): Promise<{ items: TagSuggestionResponse[]; pagination: PaginationMeta }> {
    return this.suggestions.list(user.id, query);
  }

  @Post()
  @ApiOperation({
    summary: '提交標籤建議',
    description: '若名稱已對應到既有標籤會回 409，避免製造無意義的審核工作。',
  })
  @ApiOkResponse({ type: TagSuggestionResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTagSuggestionDto,
  ): Promise<TagSuggestionResponse> {
    return this.suggestions.create(user.id, dto);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: '核准建議並建立正式標籤' })
  @ApiOkResponse({ type: TagSuggestionResponseDto })
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body() dto: ApproveTagSuggestionDto,
  ): Promise<TagSuggestionResponse> {
    return this.suggestions.approve(user.id, id, dto);
  }

  @Post(':id/merge')
  @HttpCode(200)
  @ApiOperation({
    summary: '把建議併入既有標籤',
    description: '會自動建立別名，下次出現同樣名稱就直接對應，不會再變成建議。',
  })
  @ApiOkResponse({ type: TagSuggestionResponseDto })
  merge(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body() dto: MergeTagSuggestionDto,
  ): Promise<TagSuggestionResponse> {
    return this.suggestions.merge(user.id, id, dto);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: '退回建議', description: '不建立任何標籤，但保留紀錄與理由。' })
  @ApiOkResponse({ type: TagSuggestionResponseDto })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body() dto: RejectTagSuggestionDto,
  ): Promise<TagSuggestionResponse> {
    return this.suggestions.reject(user.id, id, dto);
  }
}

@ApiTags('tags')
@Controller('questions/:questionId/tags')
export class QuestionTagsController {
  constructor(private readonly questionTags: QuestionTagsService) {}

  @Get()
  @ApiOperation({ summary: '取得題目的標籤' })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('questionId', new ZodValidationPipe(uuidSchema)) questionId: string,
  ): Promise<QuestionTags> {
    return this.questionTags.get(user.id, questionId);
  }

  @Put()
  @ApiOperation({
    summary: '設定題目的標籤',
    description:
      '主要知識點最多 1 個（資料庫部分唯一索引保證）、次要最多 2 個。' +
      '**不會遞增題目版本，也不影響 content_hash** —— 標籤是標註，不是題目內容。',
  })
  set(
    @CurrentUser() user: AuthenticatedUser,
    @Param('questionId', new ZodValidationPipe(uuidSchema)) questionId: string,
    @Body() dto: SetQuestionTagsDto,
  ): Promise<QuestionTags> {
    return this.questionTags.set(user.id, questionId, dto);
  }
}

@ApiTags('tags')
@Controller('mistakes/:questionId/error-types')
export class MistakeErrorTypesController {
  constructor(private readonly mistakeErrorTypes: MistakeErrorTypesService) {}

  @Put()
  @ApiOperation({
    summary: '標記錯題的錯誤類型',
    description: '手動標記（source = manual）。Phase 4 的 AI 分析會寫入同一張表。',
  })
  set(
    @CurrentUser() user: AuthenticatedUser,
    @Param('questionId', new ZodValidationPipe(uuidSchema)) questionId: string,
    @Body() dto: SetMistakeErrorTypesDto,
  ): Promise<{ ok: true }> {
    return this.mistakeErrorTypes.set(user.id, questionId, dto).then(() => ({ ok: true as const }));
  }
}
