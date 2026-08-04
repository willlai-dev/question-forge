import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  paginated,
  quizSessionResponseSchema,
  uuidSchema,
  type PaginationMeta,
  type QuizOutlineResponse,
  type QuizQuestionResponse,
  type QuizResultResponse,
  type QuizSessionResponse,
  type SubmitAnswerResponse,
} from '@repo/contracts';
import { createZodDto, ZodValidationPipe } from 'nestjs-zod';
import { z } from 'zod';

import { CurrentUser, type AuthenticatedUser } from '../../common/decorators';
import {
  CreateQuizSessionDto,
  ListQuizSessionsQueryDto,
  QuizOutlineResponseDto,
  QuizQuestionResponseDto,
  QuizResultResponseDto,
  QuizSessionResponseDto,
  SubmitAnswerDto,
  SubmitAnswerResponseDto,
  UpdateAnswerDto,
} from './quiz.dto';
import { QuizSessionsService } from './quiz-sessions.service';

export class QuizSessionListResponseDto extends createZodDto(
  paginated(quizSessionResponseSchema),
) {}

const positionSchema = z.coerce.number().int().positive('題號必須是正整數');

@ApiTags('quiz')
@Controller('quiz-sessions')
export class QuizSessionsController {
  constructor(private readonly quizSessions: QuizSessionsService) {}

  @Post()
  @ApiOperation({
    summary: '建立作答場次',
    description:
      '依 scopes 決定出題範圍（多個範圍取聯集），onlyMistakes 則與範圍取交集。' +
      '範圍內沒有可作答的題目時回 422 QUIZ_NO_QUESTIONS_MATCHED。',
  })
  @ApiOkResponse({ type: QuizSessionResponseDto })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateQuizSessionDto,
  ): Promise<QuizSessionResponse> {
    return this.quizSessions.create(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: '列出作答場次' })
  @ApiOkResponse({ type: QuizSessionListResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListQuizSessionsQueryDto,
  ): Promise<{ items: QuizSessionResponse[]; pagination: PaginationMeta }> {
    return this.quizSessions.list(user.id, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: '取得場次狀態與進度',
    description: 'after_submit 模式在交卷前，correctCount 一律為 null。',
  })
  @ApiOkResponse({ type: QuizSessionResponseDto })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<QuizSessionResponse> {
    return this.quizSessions.getSession(user.id, id);
  }

  @Get(':id/outline')
  @ApiOperation({
    summary: '取得整場題目導覽（供跳題選單）',
    description:
      '只回傳位置、題號、題幹前段與作答狀態，不含選項與正確答案。' +
      'isCorrect 沿用與單題端點相同的揭露判準：after_submit 模式交卷前一律為 null（FR-QUIZ-11）。',
  })
  @ApiOkResponse({ type: QuizOutlineResponseDto })
  outline(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<QuizOutlineResponse> {
    return this.quizSessions.getOutline(user.id, id);
  }

  @Get(':id/questions/:position')
  @ApiOperation({
    summary: '取得單題',
    description:
      '選項已依 option_order 排好且不含 isCorrect。' +
      '答案只會出現在 reveal 欄位：after_submit 模式交卷前一律為 null（FR-QUIZ-11）。',
  })
  @ApiOkResponse({ type: QuizQuestionResponseDto })
  question(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('position', new ZodValidationPipe(positionSchema)) position: number,
  ): Promise<QuizQuestionResponse> {
    return this.quizSessions.getQuestionAt(user.id, id, position);
  }

  @Post(':id/answers')
  @HttpCode(200)
  @ApiOperation({
    summary: '作答',
    description:
      '判分由程式的 gradeAnswer() 完成，不呼叫任何 AI（FR-QUIZ-10）。' +
      '對已作答的題目再次呼叫視為修改答案，會套用 allowAnswerChange 規則。',
  })
  @ApiOkResponse({ type: SubmitAnswerResponseDto })
  answer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body() dto: SubmitAnswerDto,
  ): Promise<SubmitAnswerResponse> {
    return this.quizSessions.answer(user.id, id, dto);
  }

  @Patch(':id/answers/:answerId')
  @ApiOperation({
    summary: '修改答案',
    description: 'allowAnswerChange = false 時回 409 QUIZ_ANSWER_CHANGE_NOT_ALLOWED。',
  })
  @ApiOkResponse({ type: SubmitAnswerResponseDto })
  updateAnswer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('answerId', new ZodValidationPipe(uuidSchema)) answerId: string,
    @Body() dto: UpdateAnswerDto,
  ): Promise<SubmitAnswerResponse> {
    return this.quizSessions.updateAnswer(user.id, id, answerId, dto);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @ApiOperation({ summary: '交卷', description: '交卷後未作答的題目標記為 skipped。' })
  @ApiOkResponse({ type: QuizResultResponseDto })
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<QuizResultResponse> {
    return this.quizSessions.submit(user.id, id);
  }

  @Get(':id/result')
  @ApiOperation({
    summary: '取得作答結果',
    description: 'after_submit 模式在交卷前回 409 QUIZ_ANSWER_NOT_REVEALED_YET。',
  })
  @ApiOkResponse({ type: QuizResultResponseDto })
  result(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<QuizResultResponse> {
    return this.quizSessions.getResult(user.id, id);
  }

  @Post(':id/abandon')
  @HttpCode(200)
  @ApiOperation({ summary: '放棄場次', description: '已作答的紀錄與錯題本不受影響。' })
  @ApiOkResponse({ type: QuizSessionResponseDto })
  abandon(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<QuizSessionResponse> {
    return this.quizSessions.abandon(user.id, id);
  }
}
