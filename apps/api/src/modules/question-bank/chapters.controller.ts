import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { uuidSchema, type ChapterResponse } from '@repo/contracts';
import { ZodValidationPipe } from 'nestjs-zod';

import { CurrentUser, type AuthenticatedUser } from '../../common/decorators';
import { ChaptersService } from './chapters.service';
import { ChapterResponseDto, CreateChapterDto, ReorderDto, UpdateChapterDto } from './question-bank.dto';

@ApiTags('chapters')
@Controller()
export class ChaptersController {
  constructor(private readonly chaptersService: ChaptersService) {}

  @Get('subjects/:subjectId/chapters')
  @ApiOperation({ summary: '列出科目底下的章節' })
  @ApiOkResponse({ type: ChapterResponseDto, isArray: true })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('subjectId', new ZodValidationPipe(uuidSchema)) subjectId: string,
  ): Promise<ChapterResponse[]> {
    return this.chaptersService.list(user.id, subjectId);
  }

  @Post('subjects/:subjectId/chapters/reorder')
  @ApiOperation({ summary: '重新排序科目底下的章節' })
  @ApiOkResponse({ type: ChapterResponseDto, isArray: true })
  reorder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('subjectId', new ZodValidationPipe(uuidSchema)) subjectId: string,
    @Body() dto: ReorderDto,
  ): Promise<ChapterResponse[]> {
    return this.chaptersService.reorder(user.id, subjectId, dto.orderedIds);
  }

  @Post('chapters')
  @ApiOperation({ summary: '建立章節' })
  @ApiOkResponse({ type: ChapterResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateChapterDto,
  ): Promise<ChapterResponse> {
    return this.chaptersService.create(user.id, dto);
  }

  @Get('chapters/:id')
  @ApiOperation({ summary: '取得單一章節' })
  @ApiOkResponse({ type: ChapterResponseDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<ChapterResponse> {
    return this.chaptersService.getOrThrow(user.id, id);
  }

  @Patch('chapters/:id')
  @ApiOperation({ summary: '更新章節' })
  @ApiOkResponse({ type: ChapterResponseDto })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body() dto: UpdateChapterDto,
  ): Promise<ChapterResponse> {
    return this.chaptersService.update(user.id, id, dto);
  }

  @Delete('chapters/:id')
  @HttpCode(200)
  @ApiOperation({
    summary: '刪除章節',
    description:
      '軟刪除章節本身，底下的題組與題目「不會」被刪除，而是退回直接隸屬科目（chapterId 設為 null）。',
  })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ ok: true }> {
    await this.chaptersService.remove(user.id, id);
    return { ok: true };
  }
}
