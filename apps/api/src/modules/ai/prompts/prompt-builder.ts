import { Injectable } from '@nestjs/common';
import type {
  AggregateStats,
  EvidenceSource,
  RepresentativeQuestion,
  ResearchPlan,
} from '@repo/contracts';

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

  /**
   * ④ 多題整合分析（規格 §11）。
   *
   * 送進去的是**程式算好的統計數字**加上代表錯題的摘要，不是整批題目原文——
   * 規格明訂「不應直接將所有完整題目一次傳給模型」。
   * 代表錯題只給題幹、使用者選了什麼、正確答案、知識點與錯誤類型，
   * 不給完整選項與解析：診斷需要的是錯誤的形狀，不是題目本身。
   */
  buildAggregateAnalysis(input: {
    stats: AggregateStats;
    representativeQuestions: RepresentativeQuestion[];
    errorTypes: { code: string; name: string; description: string | null }[];
  }): AiChatMessage[] {
    const { stats, representativeQuestions, errorTypes } = input;

    const bucketLines = (
      label: string,
      rows: { name: string; answered: number; accuracy: number | null }[],
    ): string[] =>
      rows.length === 0
        ? []
        : [
            `【${label}】`,
            ...rows.map(
              (row) =>
                `  ${row.name}：作答 ${row.answered} 題，正確率 ${row.accuracy === null ? '無資料' : `${row.accuracy}%`}`,
            ),
            '',
          ];

    const user = [
      '請依以下統計數據與代表性錯題，產生整體學習診斷。',
      '',
      `【統計期間】${stats.period.from} ～ ${stats.period.to}`,
      `（前後半段以 ${stats.period.mid} 為界；趨勢即後半段減前半段的百分點差）`,
      '',
      '【整體】',
      `  作答 ${stats.overall.totalAnswered} 題，答對 ${stats.overall.correct} 題，` +
        `正確率 ${stats.overall.accuracy === null ? '無資料' : `${stats.overall.accuracy}%`}`,
      stats.overall.responseTimeSamples > 0
        ? `  平均作答時間 ${stats.overall.avgResponseTimeMs} 毫秒` +
          `（僅 ${stats.overall.responseTimeSamples}/${stats.overall.totalAnswered} 題有記錄時間，` +
          `樣本不足時請勿據此下結論）`
        : '  沒有任何作答時間記錄，請勿對作答速度下結論。',
      '',
      ...bucketLines('各科目', stats.bySubject),
      ...bucketLines('各章節', stats.byChapter),
      ...bucketLines('各題組', stats.byQuestionGroup),

      ...(stats.byKnowledgeTag.length > 0
        ? [
            '【各知識點】',
            ...stats.byKnowledgeTag.map(
              (tag) =>
                `  ${tag.name}：作答 ${tag.answered} 題（其中 ${tag.primaryAnswered} 題以主要知識點身分），` +
                `正確率 ${tag.accuracy === null ? '無資料' : `${tag.accuracy}%`}，` +
                `趨勢 ${tag.trend === null ? '資料不足，不可判定進步或退步' : `${tag.trend > 0 ? '+' : ''}${tag.trend} 個百分點`}`,
            ),
            `  （只有 ${stats.knowledgeTagCoverage.taggedAnswered}/${stats.knowledgeTagCoverage.totalAnswered} 題的作答帶有知識點標籤，` +
              `知識點層級的結論只涵蓋這部分資料）`,
            '',
          ]
        : ['【各知識點】沒有任何作答帶有知識點標籤，不可對知識點下結論。', '']),

      ...(stats.byErrorType.length > 0
        ? [
            '【錯誤類型次數（終身累計，非本期間）】',
            ...stats.byErrorType.map(
              (type) => `  ${type.code}（${type.name}）：${type.count} 次，涵蓋 ${type.questionCount} 題`,
            ),
            '',
          ]
        : []),

      ...(stats.consecutiveWrongStreaks.length > 0
        ? [
            '【目前仍連續答錯的知識點】',
            ...stats.consecutiveWrongStreaks.map(
              (streak) => `  ${streak.knowledgeTagName}：連續答錯 ${streak.streak} 題且尚未答對`,
            ),
            '',
          ]
        : []),

      '【近期正確率變化】',
      `  前半段 ${stats.recentAccuracyChange.previousAnswered} 題，` +
        `正確率 ${stats.recentAccuracyChange.previous ?? '無資料'}；` +
        `後半段 ${stats.recentAccuracyChange.currentAnswered} 題，` +
        `正確率 ${stats.recentAccuracyChange.current ?? '無資料'}`,
      `  判定：${describeVerdict(stats.recentAccuracyChange.verdict)}`,
      '',
      stats.improved.length > 0 ? `【已改善】${stats.improved.join('、')}` : '【已改善】無',
      stats.notImproved.length > 0 ? `【未改善】${stats.notImproved.join('、')}` : '【未改善】無',
      '',

      '【代表性錯題】（依統計權重挑選，非全部錯題）',
      ...representativeQuestions.flatMap((question) => [
        `  [${question.questionId}] 第 ${question.questionNumber} 題（${question.subjectName}）`,
        `    題幹：${question.stem}`,
        `    你選了：${question.lastSelectedAnswers.join('、') || '未作答'}；正確答案：${question.correctAnswers.join('、')}`,
        `    答錯 ${question.wrongCount} 次／共作答 ${question.attemptCount} 次`,
        `    知識點：${question.knowledgeTagNames.join('、') || '未標記'}`,
        `    錯誤類型：${question.errorTypeCodes.join('、') || '未標記'}`,
      ]),
      '',

      '【可用的錯誤類型代碼】',
      ...errorTypes.map((type) => `  ${type.code}：${type.name}${type.description ? ` —— ${type.description}` : ''}`),
      '',
      '【可推薦為複習目標的 ID】',
      '  題目：' + (representativeQuestions.map((q) => q.questionId).join('、') || '無'),
      '  題組：' + (stats.byQuestionGroup.map((g) => g.id).join('、') || '無'),
      '  知識點：' + (stats.byKnowledgeTag.map((t) => t.id).join('、') || '無'),
      '',
      '限制：',
      '- weakestKnowledgeTags 的 tagName 只能用上面出現過的知識點名稱。',
      '- commonErrorTypes 的 errorTypeCode 只能用上面列出的代碼。',
      '- recommendedPractice 的 refId 只能用上面列出的 ID。',
      '- reviewPriority 的 rank 必須從 1 開始連續且不重複。',
      '- 趨勢標示「資料不足」的項目不可以拿來說進步或退步。',
      this.mockContext({
        knowledgeTagNames: stats.byKnowledgeTag.map((tag) => tag.name),
        knowledgeTagAccuracies: stats.byKnowledgeTag.map((tag) => tag.accuracy ?? 0),
        errorTypeCodes: stats.byErrorType.map((type) => type.code),
        practiceRefIds: representativeQuestions.map((question) => question.questionId),
        hasImproved: stats.improved.length > 0,
        improvedAreas: stats.improved,
        stagnantAreas: stats.notImproved,
        totalAnswered: stats.overall.totalAnswered,
      }),
    ]
      .filter((line) => line !== null && line !== undefined)
      .join('\n');

    return [
      { role: 'system', content: SYSTEM_PROMPTS.aggregate_analysis },
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

/** 把趨勢判定翻成模型看得懂的一句話，避免它自行詮釋 enum。 */
function describeVerdict(verdict: AggregateStats['recentAccuracyChange']['verdict']): string {
  switch (verdict) {
    case 'improved':
      return '有明顯進步';
    case 'not_improved':
      return '沒有進步（退步或持平在偏低水準）';
    case 'stable_ok':
      return '持平且維持在良好水準';
    case 'insufficient':
      return '資料不足，不可判定進步或退步';
  }
}
