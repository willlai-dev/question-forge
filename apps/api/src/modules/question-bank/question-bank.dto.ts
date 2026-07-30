import {
  chapterResponseSchema,
  createChapterSchema,
  createQuestionGroupSchema,
  createSubjectSchema,
  listQuestionGroupsQuerySchema,
  paginated,
  questionGroupResponseSchema,
  reorderRequestSchema,
  subjectResponseSchema,
  updateChapterSchema,
  updateQuestionGroupSchema,
  updateSubjectSchema,
} from '@repo/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class CreateSubjectDto extends createZodDto(createSubjectSchema) {}
export class UpdateSubjectDto extends createZodDto(updateSubjectSchema) {}
export class SubjectResponseDto extends createZodDto(subjectResponseSchema) {}
export class SubjectListResponseDto extends createZodDto(z.array(subjectResponseSchema)) {}

export class CreateChapterDto extends createZodDto(createChapterSchema) {}
export class UpdateChapterDto extends createZodDto(updateChapterSchema) {}
export class ChapterResponseDto extends createZodDto(chapterResponseSchema) {}

export class CreateQuestionGroupDto extends createZodDto(createQuestionGroupSchema) {}
export class UpdateQuestionGroupDto extends createZodDto(updateQuestionGroupSchema) {}
export class QuestionGroupResponseDto extends createZodDto(questionGroupResponseSchema) {}
export class QuestionGroupListResponseDto extends createZodDto(
  paginated(questionGroupResponseSchema),
) {}
export class ListQuestionGroupsQueryDto extends createZodDto(listQuestionGroupsQuerySchema) {}

export class ReorderDto extends createZodDto(reorderRequestSchema) {}
