import {
  approveTagSuggestionSchema,
  createKnowledgeTagSchema,
  createSkillTagSchema,
  createTagAliasSchema,
  createTagSuggestionSchema,
  errorTypeResponseSchema,
  knowledgeTagResponseSchema,
  listKnowledgeTagsQuerySchema,
  listTagAliasesQuerySchema,
  listTagSuggestionsQuerySchema,
  mergeTagSchema,
  mergeTagSuggestionSchema,
  rejectTagSuggestionSchema,
  resolveTagNameQuerySchema,
  resolveTagNameResponseSchema,
  setMistakeErrorTypesSchema,
  setQuestionTagsSchema,
  skillTagResponseSchema,
  tagAliasResponseSchema,
  tagSuggestionResponseSchema,
  updateErrorTypeSchema,
  updateKnowledgeTagSchema,
  updateSkillTagSchema,
} from '@repo/contracts';
import { createZodDto } from 'nestjs-zod';

export class CreateKnowledgeTagDto extends createZodDto(createKnowledgeTagSchema) {}
export class UpdateKnowledgeTagDto extends createZodDto(updateKnowledgeTagSchema) {}
export class ListKnowledgeTagsQueryDto extends createZodDto(listKnowledgeTagsQuerySchema) {}
export class KnowledgeTagResponseDto extends createZodDto(knowledgeTagResponseSchema) {}
export class MergeTagDto extends createZodDto(mergeTagSchema) {}

export class CreateSkillTagDto extends createZodDto(createSkillTagSchema) {}
export class UpdateSkillTagDto extends createZodDto(updateSkillTagSchema) {}
export class SkillTagResponseDto extends createZodDto(skillTagResponseSchema) {}

export class UpdateErrorTypeDto extends createZodDto(updateErrorTypeSchema) {}
export class ErrorTypeResponseDto extends createZodDto(errorTypeResponseSchema) {}

export class CreateTagAliasDto extends createZodDto(createTagAliasSchema) {}
export class ListTagAliasesQueryDto extends createZodDto(listTagAliasesQuerySchema) {}
export class TagAliasResponseDto extends createZodDto(tagAliasResponseSchema) {}
export class ResolveTagNameQueryDto extends createZodDto(resolveTagNameQuerySchema) {}
export class ResolveTagNameResponseDto extends createZodDto(resolveTagNameResponseSchema) {}

export class CreateTagSuggestionDto extends createZodDto(createTagSuggestionSchema) {}
export class ListTagSuggestionsQueryDto extends createZodDto(listTagSuggestionsQuerySchema) {}
export class ApproveTagSuggestionDto extends createZodDto(approveTagSuggestionSchema) {}
export class MergeTagSuggestionDto extends createZodDto(mergeTagSuggestionSchema) {}
export class RejectTagSuggestionDto extends createZodDto(rejectTagSuggestionSchema) {}
export class TagSuggestionResponseDto extends createZodDto(tagSuggestionResponseSchema) {}

export class SetQuestionTagsDto extends createZodDto(setQuestionTagsSchema) {}
export class SetMistakeErrorTypesDto extends createZodDto(setMistakeErrorTypesSchema) {}
