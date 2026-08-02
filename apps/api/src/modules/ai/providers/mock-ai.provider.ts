import { Injectable } from '@nestjs/common';

import type { AiCompletionRequest, AiCompletionResult, AiProvider } from './ai-provider';

/**
 * 測試與開發用的 AI Provider。
 *
 * 存在的理由（IMPLEMENTATION_PLAN 4b）：**先做 Mock 再做真實 provider，
 * 可以在不消耗免費額度的情況下把整條三階段流程跑通。**
 * 流程出問題時也能立刻分辨是自己的邏輯錯，還是外部服務的行為。
 *
 * 它產生的是「結構與語意都正確」的固定輸出 ——
 * 刻意不模擬模型的不穩定性，因為那會讓端到端測試變得不可重現。
 * 對錯誤路徑的測試改由單元測試直接餵壞資料給驗證層。
 */
@Injectable()
export class MockAiProvider implements AiProvider {
  readonly name = 'mock';
  readonly model = 'mock/deterministic-v1';

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const content = JSON.stringify(this.buildResponse(request));

    return {
      content,
      finishReason: 'stop',
      model: this.model,
      usage: {
        inputTokens: estimateTokens(request.messages.map((m) => m.content).join('')),
        outputTokens: estimateTokens(content),
        totalTokens: null,
      },
      httpStatus: 200,
    };
  }

  private buildResponse(request: AiCompletionRequest): unknown {
    const context = parseMockContext(request);

    switch (request.operation) {
      case 'research_plan':
        return {
          needsExternalSearch: true,
          researchMode: 'WEB_RESEARCH',
          reason: '（模擬）這題涉及具體法規條文，需要查證現行條文內容。',
          queries: ['模擬查詢：題目關鍵概念'],
          preferredDomains: ['law.moj.gov.tw'],
          preferredSourceTypes: ['official'],
          freshnessRequired: false,
          keyClaimsToVerify: ['（模擬）待查證的關鍵論點'],
        };

      case 'evidence_synthesis':
        return {
          evidenceSummary: '（模擬）依據查得的來源，題庫標示的答案與現行規定一致。',
          supportedClaims:
            context.sourceIds.length > 0
              ? [
                  {
                    claim: '（模擬）題庫答案與來源一致',
                    sourceIds: [context.sourceIds[0]!],
                    strength: 'strong',
                  },
                ]
              : [],
          contradictedClaims: [],
          conflicts: [],
          insufficientEvidence: context.sourceIds.length === 0,
          recommendedAnswer: context.correctAnswers,
          confidence: context.sourceIds.length === 0 ? 0.4 : 0.85,
          requiresHumanReview: context.sourceIds.length === 0,
        };

      case 'final_explanation': {
        // 題幹含衝突標記時，模擬「AI 認為題庫答案有誤」。
        // 沒有這條路徑，答案爭議與爭議題隔離（驗收 #17、#18）就只能靠讀程式碼相信它會動。
        const disagrees = context.expectConflict;
        const verifiedAnswers = disagrees
          ? context.optionKeys.filter((key) => !context.correctAnswers.includes(key)).slice(0, 1)
          : context.correctAnswers;

        return {
          answerValidation: {
            agreesWithStoredAnswer: !disagrees,
            verifiedAnswers,
            conflictReason: disagrees
              ? '（模擬）依查得的現行條文，題庫標示的答案與規定不符。'
              : null,
            confidence: disagrees ? 0.78 : 0.85,
          },
          explanation: {
            coreConcept: '（模擬）本題的核心概念說明。',
            solutionSteps: ['（模擬）第一步：辨識題目要問什麼', '（模擬）第二步：套用對應規則'],
            summary: '（模擬）完整解析內容。',
          },
          // 標為正確的選項必須與 verifiedAnswers 完全一致，否則會被語意驗證擋下。
          optionAnalysis: context.optionKeys.map((key) => ({
            key,
            isCorrect: verifiedAnswers.includes(key),
            reason: verifiedAnswers.includes(key)
              ? `（模擬）選項 ${key} 符合題目所述條件。`
              : `（模擬）選項 ${key} 不符合，因為缺少必要要件。`,
          })),
          mistakeAnalysis: {
            userWasCorrect: context.userWasCorrect,
            whyUserMightBeWrong: context.userWasCorrect
              ? null
              : '（模擬）可能把兩個相似概念搞混了。',
            missedConditions: context.userWasCorrect ? [] : ['（模擬）忽略了題目的但書'],
            errorTypeCode: context.userWasCorrect
              ? context.fallbackErrorTypeCode
              : (context.allowedErrorTypeCodes[0] ?? context.fallbackErrorTypeCode),
            primaryKnowledgeTag: context.allowedKnowledgeTags[0] ?? '（模擬）未知知識點',
            secondaryKnowledgeTags: [],
            skillTag: context.allowedSkillTags[0] ?? null,
            reviewSuggestions: ['（模擬）建議重新複習相關章節的定義與例外規定。'],
            // 一律提出一個新標籤建議，讓「AI 只能建議、不能建立」這條路徑
            // 在每次端到端測試中都被實際走過，而不是只存在於程式碼裡。
            suggestedNewTags: [
              {
                kind: 'knowledge',
                name: '（模擬）AI 建議的新知識點',
                rationale: '（模擬）現有標籤中找不到完全對應的概念。',
              },
            ],
          },
          citations: context.sourceIds.slice(0, 2).map((sourceId) => ({
            sourceId,
            quote: '（模擬）引用的原文片段。',
            relevance: 'direct',
          })),
          confidence: 0.85,
          // 質疑題庫答案時必須標記需要人工審核，這也是語意驗證的規則之一。
          requiresHumanReview: disagrees,
        };
      }

      case 'aggregate_analysis': {
        // 一律從脈絡給的清單裡挑，讓輸出必定通得過參照完整性驗證 ——
        // 這條路徑要驗的是流程，不是模型的造詞能力。
        const tags = context.knowledgeTagNames;
        const accuracyOf = (index: number) => context.knowledgeTagAccuracies[index] ?? 0;

        const weakest = tags.slice(0, 3).map((tagName, index) => ({
          tagName,
          accuracy: accuracyOf(index),
          severity:
            accuracyOf(index) < 40 ? 'critical' : accuracyOf(index) < 70 ? 'high' : 'moderate',
          evidence: `此知識點的正確率為 ${accuracyOf(index)}%。`,
        }));

        const errorTypes = context.errorTypeCodes.slice(0, 3).map((errorTypeCode) => ({
          errorTypeCode,
          count: 1,
          interpretation: `統計顯示 ${errorTypeCode} 反覆出現。`,
        }));

        const priorityTargets = [...tags.slice(0, 3), ...context.stagnantAreas].slice(0, 5);

        return {
          weakestKnowledgeTags: weakest,
          commonErrorTypes: errorTypes,
          errorPatterns:
            tags.length >= 2
              ? [
                  {
                    pattern: '多個知識點都錯在例外規定',
                    relatedKnowledgeTags: tags.slice(0, 2),
                    relatedErrorTypes: context.errorTypeCodes.slice(0, 1),
                    explanation: '跨知識點的共同錯誤，通常代表讀法問題而非個別知識缺口。',
                  },
                ]
              : [],
          // rank 必須從 1 開始連續不重複，這正是語意驗證會檢查的規則。
          reviewPriority: priorityTargets.map((target, index) => ({
            rank: index + 1,
            target,
            reason: '依統計的正確率與連續錯誤排序。',
          })),
          recommendedPractice: context.practiceRefIds.slice(0, 5).map((refId) => ({
            kind: 'question' as const,
            refId,
            label: `題目 ${refId.slice(0, 8)}`,
            reason: '反覆答錯，建議優先重練。',
          })),
          improvement: {
            hasImproved: context.hasImproved,
            // hasImproved 為 true 時必須列出至少一項，否則語意驗證會擋下。
            improvedAreas: context.hasImproved ? context.improvedAreas : [],
            stagnantAreas: context.stagnantAreas,
            summary: context.hasImproved ? '部分知識點已有進步。' : '本期間尚未看到明顯進步。',
          },
          learningSuggestions: [
            '先把正確率最低的知識點的定義與例外整理成一頁筆記。',
            '重練代表錯題，並在作答前先講出選擇的理由。',
          ],
          analysisBasis: `依據期間內 ${context.totalAnswered} 筆作答的統計，以及 ${context.practiceRefIds.length} 題代表性錯題。`,
          // 沒有任何統計資料時不該裝作很有把握。
          confidence: context.totalAnswered === 0 ? 0.3 : 0.8,
        };
      }

      default:
        return {};
    }
  }
}

/**
 * 從組好的 prompt 中取回結構化脈絡。
 *
 * Mock 需要知道「這題有哪些選項、正確答案是什麼、允許哪些標籤」才能產生
 * 通得過語意驗證的輸出。與其重新解析自然語言，
 * PromptBuilder 會在訊息尾端附上一段機器可讀的 JSON 供 Mock 使用；
 * 真實 provider 會把它當成一般文字忽略。
 */
export const MOCK_CONTEXT_MARKER = '<<<MOCK_CONTEXT>>>';

interface MockContext {
  optionKeys: string[];
  correctAnswers: string[];
  sourceIds: string[];
  userWasCorrect: boolean;
  allowedKnowledgeTags: string[];
  allowedSkillTags: string[];
  allowedErrorTypeCodes: string[];
  fallbackErrorTypeCode: string;
  /** 題幹含衝突標記時為 true，用來走「AI 質疑題庫答案」的路徑。 */
  expectConflict: boolean;

  // --- 多題整合分析（Phase 5）---
  knowledgeTagNames: string[];
  knowledgeTagAccuracies: number[];
  errorTypeCodes: string[];
  practiceRefIds: string[];
  hasImproved: boolean;
  improvedAreas: string[];
  stagnantAreas: string[];
  totalAnswered: number;
}

/** 題幹含這段文字時，Mock 會回報答案衝突。僅供測試用。 */
export const MOCK_CONFLICT_MARKER = '【衝突測試】';

function parseMockContext(request: AiCompletionRequest): MockContext {
  const empty: MockContext = {
    optionKeys: ['A', 'B'],
    correctAnswers: ['A'],
    sourceIds: [],
    userWasCorrect: true,
    allowedKnowledgeTags: [],
    allowedSkillTags: [],
    allowedErrorTypeCodes: [],
    fallbackErrorTypeCode: 'undetermined',
    expectConflict: false,
    knowledgeTagNames: [],
    knowledgeTagAccuracies: [],
    errorTypeCodes: [],
    practiceRefIds: [],
    hasImproved: false,
    improvedAreas: [],
    stagnantAreas: [],
    totalAnswered: 0,
  };

  for (const message of request.messages) {
    const index = message.content.indexOf(MOCK_CONTEXT_MARKER);
    if (index === -1) continue;
    try {
      const raw = message.content.slice(index + MOCK_CONTEXT_MARKER.length).trim();
      return { ...empty, ...(JSON.parse(raw) as Partial<MockContext>) };
    } catch {
      return empty;
    }
  }
  return empty;
}

/** 粗略估算 token 數，僅供 Mock 的用量紀錄看起來合理。 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
