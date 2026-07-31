import { Module } from '@nestjs/common';

import { KnowledgeTagsService } from './knowledge-tags.service';
import { MistakeErrorTypesService } from './mistake-error-types.service';
import { QuestionTagsService } from './question-tags.service';
import { TagAliasesService } from './tag-aliases.service';
import { TagSeedService } from './tag-seed.service';
import { TagSuggestionsService } from './tag-suggestions.service';
import {
  KnowledgeTagsController,
  MistakeErrorTypesController,
  QuestionTagsController,
  TagAliasesController,
  TagResolveController,
  TagSuggestionsController,
  VocabularyController,
} from './tags.controller';
import { VocabularyService } from './vocabulary.service';

/**
 * 受控標籤系統（規格 §8）。
 *
 * QuestionTagsService 被 questions 模組用來把標籤帶進題目列表，
 * 因此對外匯出；其餘服務只在本模組內使用。
 */
@Module({
  controllers: [
    KnowledgeTagsController,
    VocabularyController,
    TagAliasesController,
    TagResolveController,
    TagSuggestionsController,
    QuestionTagsController,
    MistakeErrorTypesController,
  ],
  providers: [
    KnowledgeTagsService,
    VocabularyService,
    TagAliasesService,
    TagSuggestionsService,
    QuestionTagsService,
    MistakeErrorTypesService,
    TagSeedService,
  ],
  exports: [QuestionTagsService, TagSeedService],
})
export class TagsModule {}
