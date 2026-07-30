import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { uuidSchema, type SubjectResponse } from '@repo/contracts';
import { ZodValidationPipe } from 'nestjs-zod';

import { CurrentUser, type AuthenticatedUser } from '../../common/decorators';
import {
  CreateSubjectDto,
  ReorderDto,
  SubjectResponseDto,
  UpdateSubjectDto,
} from './question-bank.dto';
import { SubjectsService } from './subjects.service';

@ApiTags('subjects')
@Controller('subjects')
export class SubjectsController {
  constructor(private readonly subjectsService: SubjectsService) {}

  @Get()
  @ApiOperation({ summary: '列出所有科目（含章節、題組與題目數量）' })
  @ApiOkResponse({ type: SubjectResponseDto, isArray: true })
  list(@CurrentUser() user: AuthenticatedUser): Promise<SubjectResponse[]> {
    return this.subjectsService.list(user.id);
  }

  @Post()
  @ApiOperation({ summary: '建立科目' })
  @ApiOkResponse({ type: SubjectResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateSubjectDto,
  ): Promise<SubjectResponse> {
    return this.subjectsService.create(user.id, dto);
  }

  @Post('reorder')
  @ApiOperation({ summary: '重新排序科目', description: '依 orderedIds 的順序寫入 sortOrder。' })
  @ApiOkResponse({ type: SubjectResponseDto, isArray: true })
  reorder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReorderDto,
  ): Promise<SubjectResponse[]> {
    return this.subjectsService.reorder(user.id, dto.orderedIds);
  }

  @Get(':id')
  @ApiOperation({ summary: '取得單一科目' })
  @ApiOkResponse({ type: SubjectResponseDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<SubjectResponse> {
    return this.subjectsService.getOrThrow(user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新科目' })
  @ApiOkResponse({ type: SubjectResponseDto })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body() dto: UpdateSubjectDto,
  ): Promise<SubjectResponse> {
    return this.subjectsService.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary: '刪除科目',
    description: '軟刪除，並連帶軟刪除其下的章節、題組與題目。歷史作答紀錄不受影響。',
  })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ ok: true }> {
    await this.subjectsService.remove(user.id, id);
    return { ok: true };
  }
}
