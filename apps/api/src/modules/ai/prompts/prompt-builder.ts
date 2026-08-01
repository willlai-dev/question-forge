import { Injectable } from '@nestjs/common';
import type { EvidenceSource, ResearchPlan } from '@repo/contracts';

import { MOCK_CONFLICT_MARKER, MOCK_CONTEXT_MARKER } from '../providers/mock-ai.provider';
import type { AiChatMessage } from '../providers/ai-provider';
import { SYSTEM_PROMPTS, wrapUntrustedContent } from './prompt-templates';

export interface QuestionContext {
  stem: string;
  type: 'single_choice' | 'multiple_choice';
  options: { key: string; text: string }[];
  correctAnswers: string[];
  existingExplanation: string | null;
  subjectName: string;
  chapterName: string | null;
  questionGroupName: string;
  sourceReference: string | null;
  sourcePage: number | null;
}

export interface AllowedVocabulary {
  knowledgeTags: string[];
  skillTags: string[];
  errorTypes: { code: string; name: string; description: string | null }[];
  fallbackErrorTypeCode: string;
}

export interface UserAnswerContext {
  selectedAnswers: string[];
  isCorrect: boolean;
  /** 同一知識點的既往表現，讓解析能指出重複犯的錯。 */
  relatedMistakeCount: number;
}

/**
 * 組裝送給模型的訊息。
 *
 * 輸入一律由程式組裝，模型不能自行取得任何資料 ——
 * 它看到的每一個字都是這裡放進去的。
 */
@Injectable()
export class PromptBuilder {
  buildResearchPlan(question: QuestionContext, availableTags: string[]): AiChatMessage[] {
    const user = [
      '請規劃這道題目的查證方向。',
      '',
      this.renderQuestion(question),
      '',
      `目前題庫可用的知識點：${availableTags.length > 0 ? availableTags.join('、') : '（尚未建立）'}`,
      question.sourceReference ? `題目來源：${question.sourceReference}` : '',
      this.mockContext({
        optionKeys: question.options.map((o) => o.key),
        correctAnswers: question.correctAnswers,
      }),
    ]
      .filter(Boolean)
      .join('\n');

    return [
      { role: 'system', content: SYSTEM_PROMPTS.research_plan },
      { role: 'user', content: user },
    ];
  }

  buildEvidenceSynthesis(
    question: QuestionContext,
    plan: ResearchPlan,
    sources: EvidenceSource[],
  ): AiChatMessage[] {
    const evidenceBlock =
      sources.length > 0
        ? sources
            .map((source) =>
              wrapUntrustedContent(source.sourceId, source.title, source.url, source.content),
            )
            .join('\n\n')
        : '（本次沒有取得任何外部資料）';

    const user = [
      '請根據下列外部資料整理證據，判斷題庫標示的答案是否得到支持。',
      '',
      this.renderQuestion(question),
      '',
      `研究計畫：${plan.reason}`,
      `要查證的重點：${plan.keyClaimsToVerify.join('；') || '（未指定）'}`,
      '',
      `可引用的來源編號：${sources.map((s) => s.sourceId).join('、') || '（無）'}`,
      '',
      evidenceBlock,
      this.mockContext({
        optionKeys: question.options.map((o) => o.key),
        correctAnswers: question.correctAnswers,
        sourceIds: sources.map((s) => s.sourceId),
      }),
    ].join('\n');

    return [
      { role: 'system', content: SYSTEM_PROMPTS.evidence_synthesis },
      { role: 'user', content: user },
    ];
  }

  buildFinalExplanation(input: {
    question: QuestionContext;
    plan: ResearchPlan;
    sources: EvidenceSource[];
    evidenceSummary: string;
    userAnswer: UserAnswerContext | null;
    vocabulary: AllowedVocabulary;
  }): AiChatMessage[] {
    const { question, sources, vocabulary, userAnswer } = input;

    const evidenceBlock =
      sources.length > 0
        ? sources
            .map((source) =>
              wrapUntrustedContent(source.sourceId, source.title, source.url, source.content),
            )
            .join('\n\n')
        : '（本次沒有取得任何外部資料）';

    const user = [
      '請為這道題目產生完整解析。',
      '',
      this.renderQuestion(question),
      '',
      userAnswer
        ? [
            `使用者選了：${userAnswer.selectedAnswers.join('、') || '（未作答）'}`,
            `是否答對：${userAnswer.isCorrect ? '是' : '否'}`,
            userAnswer.relatedMistakeCount > 0
              ? `使用者在相同知識點上已累積 ${userAnswer.relatedMistakeCount} 次錯誤。`
              : '',
          ]
            .filter(Boolean)
            .join('\n')
        : '（本次沒有使用者作答，只需產生題目層級的通用解析，userWasCorrect 請填 true）',
      '',
      '【允許使用的標籤，只能從這裡選】',
      `知識點：${vocabulary.knowledgeTags.join('、') || '（尚未建立任何知識點）'}`,
      `能力類型：${vocabulary.skillTags.join('、') || '（無）'}`,
      `錯誤類型（請填 code）：${vocabulary.errorTypes.map((t) => `${t.code}（${t.name}）`).join('、')}`,
      `使用者答對時必須使用的 code：${vocabulary.fallbackErrorTypeCode}`,
      '',
      `研究模式：${input.plan.researchMode}`,
      `證據摘要：${input.evidenceSummary || '（無）'}`,
      `可引用的來源編號：${sources.map((s) => s.sourceId).join('、') || '（無，citations 請填空陣列）'}`,
      '',
      evidenceBlock,
      this.mockContext({
        optionKeys: question.options.map((o) => o.key),
        correctAnswers: question.correctAnswers,
        sourceIds: sources.map((s) => s.sourceId),
        userWasCorrect: userAnswer ? userAnswer.isCorrect : true,
        allowedKnowledgeTags: vocabulary.knowledgeTags,
        allowedSkillTags: vocabulary.skillTags,
        allowedErrorTypeCodes: vocabulary.errorTypes.map((t) => t.code),
        fallbackErrorTypeCode: vocabulary.fallbackErrorTypeCode,
        expectConflict: question.stem.includes(MOCK_CONFLICT_MARKER),
      }),
    ].join('\n');

    return [
      { role: 'system', content: SYSTEM_PROMPTS.final_explanation },
      { role: 'user', content: user },
    ];
  }

  private renderQuestion(question: QuestionContext): string {
    return [
      `【題目】（${question.subjectName}${question.chapterName ? ` / ${question.chapterName}` : ''} / ${question.questionGroupName}）`,
      `題型：${question.type === 'single_choice' ? '單選' : '複選'}`,
      `題幹：${question.stem}`,
      '選項：',
      ...question.options.map((option) => `  ${option.key}. ${option.text}`),
      `題庫標示的正確答案：${question.correctAnswers.join('、')}`,
      question.existingExplanation
        ? `題庫原有解析：${question.existingExplanation}`
        : '題庫沒有現成解析。',
    ].join('\n');
  }

  /**
   * 給 MockAiProvider 用的機器可讀脈絡。
   *
   * 真實模型會把它當成一般文字（前面已有明確的輸出格式限制，不影響結果），
   * Mock 則靠它產生「通得過語意驗證」的固定輸出，
   * 讓端到端測試不必依賴真實 API 也能驗證整條流程。
   */
  private mockContext(context: Record<string, unknown>): string {
    return `\n${MOCK_CONTEXT_MARKER}\n${JSON.stringify(context)}`;
  }
}
