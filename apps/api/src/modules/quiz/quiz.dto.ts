import {
  createMistakePracticeSchema,
  createQuizSessionSchema,
  listMistakesQuerySchema,
  listQuizSessionsQuerySchema,
  mistakeDetailResponseSchema,
  mistakeResponseSchema,
  mistakeStatsResponseSchema,
  quizOutlineResponseSchema,
  quizQuestionResponseSchema,
  quizResultResponseSchema,
  quizSessionResponseSchema,
  submitAnswerResponseSchema,
  submitAnswerSchema,
  submitQuizSessionSchema,
  updateAnswerSchema,
} from '@repo/contracts';
import { createZodDto } from 'nestjs-zod';

/** 同一份 Zod schema 同時做 request 驗證與 OpenAPI 產生，前後端不會有兩套規則。 */

export class CreateQuizSessionDto extends createZodDto(createQuizSessionSchema) {}
export class ListQuizSessionsQueryDto extends createZodDto(listQuizSessionsQuerySchema) {}
export class SubmitAnswerDto extends createZodDto(submitAnswerSchema) {}
export class SubmitQuizSessionDto extends createZodDto(submitQuizSessionSchema) {}
export class UpdateAnswerDto extends createZodDto(updateAnswerSchema) {}
export class QuizSessionResponseDto extends createZodDto(quizSessionResponseSchema) {}
export class QuizQuestionResponseDto extends createZodDto(quizQuestionResponseSchema) {}
export class QuizOutlineResponseDto extends createZodDto(quizOutlineResponseSchema) {}
export class SubmitAnswerResponseDto extends createZodDto(submitAnswerResponseSchema) {}
export class QuizResultResponseDto extends createZodDto(quizResultResponseSchema) {}

export class ListMistakesQueryDto extends createZodDto(listMistakesQuerySchema) {}
export class CreateMistakePracticeDto extends createZodDto(createMistakePracticeSchema) {}
export class MistakeResponseDto extends createZodDto(mistakeResponseSchema) {}
export class MistakeDetailResponseDto extends createZodDto(mistakeDetailResponseSchema) {}
export class MistakeStatsResponseDto extends createZodDto(mistakeStatsResponseSchema) {}
