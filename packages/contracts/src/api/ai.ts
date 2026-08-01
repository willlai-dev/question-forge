import { z } from 'zod';

import { aiOperationSchema, confidenceSchema, researchModeSchema, trustTierSchema } from '../ai/common';
import { paginationQuerySchema, uuidSchema } from './common';

/**
 * AI 分析的 API 契約（規格 §13）。
 *
 * 分析一律是非同步任務：規劃階段實測模型延遲 4～8 秒、伺服器自報排隊 41 筆，
 * 三階段串起來同步等待必然逾時。因此 `POST /ai/questions/:id/analyze` 只回 jobId，
 * 前端輪詢 `GET /ai/jobs/:id` 取得進度。
 */

export const aiJobStatusSchema = z.enum([
  'pending',
  'active',
  'completed',
  'failed',
  'retrying',
  'cancelled',
]);
export type AiJobStatus = z.infer<typeof aiJobStatusSchema>;

/** 進度步驟。前端據此顯示「現在在做什麼」。 */
export const aiProgressStepSchema = z.enum([
  'QUEUED',
  'ANALYZING_QUESTION',
  'SEARCHING_SOURCES',
  'SYNTHESIZING_EVIDENCE',
  'GENERATING_EXPLANATION',
  'SAVING_RESULT',
  'COMPLETED',
]);
export type AiProgressStep = z.infer<typeof aiProgressStepSchema>;

/** 各步驟對應的進度百分比與顯示文字，前後端共用同一份定義。 */
export const AI_PROGRESS_STEPS: Record<AiProgressStep, { pct: number; label: string }> = {
  QUEUED: { pct: 0, label: '排隊中' },
  ANALYZING_QUESTION: { pct: 10, label: '分析題目與規劃查證方向' },
  SEARCHING_SOURCES: { pct: 35, label: '搜尋並擷取外部資料' },
  SYNTHESIZING_EVIDENCE: { pct: 60, label: '整理證據' },
  GENERATING_EXPLANATION: { pct: 85, label: '產生完整解析' },
  SAVING_RESULT: { pct: 95, label: '保存結果' },
  COMPLETED: { pct: 100, label: '完成' },
};

export const analyzeQuestionSchema = z
  .object({
    /** 使用者的作答；不給則只產生題目層級的通用解析。 */
    userAnswerId: uuidSchema.nullish(),
    /** 忽略快取強制重新分析（規格 §12 的手動失效條件）。 */
    force: z.boolean().default(false),
    priority: z.number().int().min(1).max(4).default(2),
  })
  .strict();
export type AnalyzeQuestionRequest = z.infer<typeof analyzeQuestionSchema>;

export const aiJobResponseSchema = z.object({
  id: z.string().uuid(),
  jobType: z.enum(['question_analysis', 'aggregate_analysis', 'maintenance']),
  status: aiJobStatusSchema,
  progressStep: aiProgressStepSchema,
  progressPct: z.number().int(),
  questionId: z.string().uuid().nullable(),
  priority: z.number().int(),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  cancelledAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  /** 命中快取時直接完成，完全沒有呼叫模型。 */
  servedFromCache: z.boolean(),
});
export type AiJobResponse = z.infer<typeof aiJobResponseSchema>;

export const listAiJobsQuerySchema = paginationQuerySchema.extend({
  status: aiJobStatusSchema.optional(),
  questionId: uuidSchema.optional(),
});
export type ListAiJobsQuery = z.infer<typeof listAiJobsQuerySchema>;

// ------------------------------------------------------------ 分析結果

export const evidenceSourceResponseSchema = z.object({
  sourceId: z.string(),
  url: z.string(),
  domain: z.string(),
  title: z.string(),
  publishedDate: z.string().nullable(),
  fetchedAt: z.string().datetime(),
  trustTier: trustTierSchema,
  contentSnippet: z.string(),
  searchQuery: z.string().nullable(),
  rank: z.number().int().nullable(),
  score: z.number().nullable(),
  /** AI 是否實際引用了這個來源。 */
  isUsed: z.boolean(),
});
export type EvidenceSourceResponse = z.infer<typeof evidenceSourceResponseSchema>;

export const optionAnalysisSchema = z.object({
  key: z.string(),
  isCorrect: z.boolean(),
  reason: z.string(),
});

export const questionAnalysisResponseSchema = z.object({
  questionId: z.string().uuid(),
  /** 產生這份解析時的題目內容雜湊。與目前不符代表題目已被修改。 */
  questionContentHash: z.string(),
  isStale: z.boolean(),
  researchMode: researchModeSchema,
  model: z.string(),

  coreConcept: z.string(),
  solutionSteps: z.array(z.string()),
  canonicalExplanation: z.string(),
  optionAnalysis: z.array(optionAnalysisSchema),

  answerValidation: z.object({
    agreesWithStoredAnswer: z.boolean(),
    verifiedAnswers: z.array(z.string()),
    conflictReason: z.string().nullable(),
    confidence: confidenceSchema,
  }),

  /** 個人化錯因分析；沒有帶作答時為 null。 */
  personalized: z
    .object({
      selectedAnswers: z.array(z.string()),
      correctAnswers: z.array(z.string()),
      userWasCorrect: z.boolean(),
      whyWrong: z.string().nullable(),
      missedConditions: z.array(z.string()),
      errorTypeCode: z.string().nullable(),
      errorTypeName: z.string().nullable(),
      reviewSuggestions: z.array(z.string()),
      citations: z.array(z.object({ sourceId: z.string(), quote: z.string().nullable(), relevance: z.string() })),
    })
    .nullable(),

  sources: z.array(evidenceSourceResponseSchema),
  /** 對不上既有標籤而改寫入建議的名稱，前端據此顯示「知識點待補」。 */
  pendingTagSuggestions: z.array(z.string()),
  confidence: confidenceSchema,
  requiresHumanReview: z.boolean(),
  generatedAt: z.string().datetime(),
});
export type QuestionAnalysisResponse = z.infer<typeof questionAnalysisResponseSchema>;

// ------------------------------------------------------------ 答案衝突

export const conflictReviewStatusSchema = z.enum([
  'pending',
  'kept_original',
  'answer_updated',
  'explanation_updated',
  'marked_disputed',
  'question_excluded',
]);
export type ConflictReviewStatus = z.infer<typeof conflictReviewStatusSchema>;

export const answerConflictResponseSchema = z.object({
  id: z.string().uuid(),
  questionId: z.string().uuid(),
  questionStem: z.string(),
  questionNumber: z.number().int(),
  subjectName: z.string(),
  options: z.array(z.object({ key: z.string(), text: z.string(), isCorrect: z.boolean() })),
  storedAnswers: z.array(z.string()),
  verifiedAnswers: z.array(z.string()),
  confidence: confidenceSchema,
  conflictReason: z.string(),
  sourceIds: z.array(z.string()),
  sources: z.array(evidenceSourceResponseSchema),
  reviewStatus: conflictReviewStatusSchema,
  reviewedAt: z.string().datetime().nullable(),
  reviewNote: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type AnswerConflictResponse = z.infer<typeof answerConflictResponseSchema>;

/**
 * 人工裁決。五種決策對應規格 §10 的處理選項。
 *
 * `answer_updated` 是唯一會改動題庫答案的路徑，而且**只能由人觸發** ——
 * AI 永遠不會自己改答案（規格 §10 明文）。
 */
export const resolveConflictSchema = z
  .object({
    decision: z.enum([
      'kept_original',
      'answer_updated',
      'explanation_updated',
      'marked_disputed',
      'question_excluded',
    ]),
    /** decision 為 answer_updated 時必填。 */
    correctAnswers: z.array(z.string().regex(/^[A-Z]$/)).optional(),
    /** decision 為 explanation_updated 時必填。 */
    explanation: z.string().trim().max(8000).optional(),
    reviewNote: z.string().trim().max(1000).nullish(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === 'answer_updated' && (value.correctAnswers ?? []).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['correctAnswers'],
        message: '選擇修改答案時必須指定新的正確答案',
      });
    }
    if (value.decision === 'explanation_updated' && !value.explanation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['explanation'],
        message: '選擇更新解析時必須提供解析內容',
      });
    }
  });
export type ResolveConflictRequest = z.infer<typeof resolveConflictSchema>;

export const listConflictsQuerySchema = paginationQuerySchema.extend({
  reviewStatus: conflictReviewStatusSchema.optional(),
});
export type ListConflictsQuery = z.infer<typeof listConflictsQuerySchema>;

// ------------------------------------------------------------ 用量

export const aiUsageResponseSchema = z.object({
  totalCalls: z.number().int(),
  successCalls: z.number().int(),
  failedCalls: z.number().int(),
  totalInputTokens: z.number().int(),
  totalOutputTokens: z.number().int(),
  avgLatencyMs: z.number().int().nullable(),
  p95LatencyMs: z.number().int().nullable(),
  byOperation: z.array(
    z.object({
      operation: aiOperationSchema,
      calls: z.number().int(),
      successRate: z.number().nullable(),
      avgLatencyMs: z.number().int().nullable(),
      totalTokens: z.number().int(),
    }),
  ),
  byStatus: z.array(z.object({ status: z.string(), count: z.number().int() })),
});
export type AiUsageResponse = z.infer<typeof aiUsageResponseSchema>;

export const promptVersionResponseSchema = z.object({
  id: z.string().uuid(),
  operation: aiOperationSchema,
  version: z.string(),
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
});
export type PromptVersionResponse = z.infer<typeof promptVersionResponseSchema>;
