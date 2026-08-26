'use client';

import {
  AI_PROGRESS_STEPS,
  type AiJobResponse,
  type QuestionAnalysisResponse,
} from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { HoverPanel } from '@/components/hover-panel';
import { Button, Card, ErrorBanner } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

const TRUST_TIER_LABEL: Record<string, string> = {
  official: '官方',
  academic: '學術',
  educational: '教學',
  reference: '參考',
  other: '其他',
};

/**
 * 單題 AI 解析。
 *
 * 分析是非同步的（模型延遲 4～8 秒 × 三階段），因此這裡輪詢任務進度。
 * 輪詢間隔 1.5 秒 —— 規格 §13 要求 1～2 秒。
 */
export function AiAnalysisPanel({
  questionId,
  userAnswerId,
  startSignal = 0,
}: {
  questionId: string;
  userAnswerId?: string | null;
  /**
   * 由外部觸發分析的訊號（例如作答頁的 E → Enter 快捷鍵）。
   *
   * 用遞增的數字而不是 boolean：boolean 只能表達「要不要」，
   * 連按兩次快捷鍵時第二次不會有任何反應。數字每次都不同，因此每次都觸發得了。
   */
  startSignal?: number;
}) {
  const qc = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);

  /**
   * 找出這一題目前是否已經有在跑的分析任務。
   *
   * 為什麼需要這個：分析是非同步的，使用者本來就會按下去之後先去做下一題，
   * 等一下再回來看。但「哪個任務正在跑」原本只存在元件的 local state 裡，
   * 一離開就沒了——回來時面板會以為什麼都沒發生，只顯示「開始分析」按鈕，
   * 進度完全看不到。改成從伺服器問，狀態就不再綁在這次的元件生命週期上。
   */
  const runningJob = useQuery({
    queryKey: ['ai-job-for-question', questionId],
    queryFn: () =>
      api.get<{ items: AiJobResponse[] }>(`/ai/jobs?questionId=${questionId}&pageSize=1`),
    // 已經知道 jobId 或已經有結果時就不必再問。
    enabled: jobId === null,
    retry: false,
  });

  // 伺服器說還有任務在跑 → 接手它，進度條就會接續顯示。
  useEffect(() => {
    if (jobId !== null) return;
    const latest = runningJob.data?.items?.[0];
    if (!latest) return;
    if (latest.status === 'pending' || latest.status === 'active' || latest.status === 'retrying') {
      setJobId(latest.id);
    }
  }, [runningJob.data, jobId]);

  const analysis = useQuery({
    queryKey: ['analysis', questionId, userAnswerId ?? null],
    queryFn: () =>
      api.get<QuestionAnalysisResponse>(
        `/questions/${questionId}/analysis${userAnswerId ? `?userAnswerId=${userAnswerId}` : ''}`,
      ),
    retry: false,
  });

  const job = useQuery({
    queryKey: ['ai-job', jobId],
    queryFn: () => api.get<AiJobResponse>(`/ai/jobs/${jobId}`),
    enabled: jobId !== null,
    // 任務結束後停止輪詢，避免無謂的請求。
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'completed' || status === 'failed' || status === 'cancelled' ? false : 1500;
    },
  });

  const start = useMutation({
    mutationFn: (force: boolean) =>
      api.post<AiJobResponse>(`/ai/questions/${questionId}/analyze`, {
        force,
        ...(userAnswerId ? { userAnswerId } : {}),
      }),
    onSuccess: (created) => setJobId(created.id),
  });

  // 任務完成後重新拉解析。
  //
  // 一定要放在 effect 裡：在 render 期間呼叫 invalidateQueries 是在 render 中觸發副作用，
  // 會引發額外的 render 迴圈。原本掛在錯題詳情頁還不容易發生，
  // 但現在這個面板也出現在作答流程中，每答一題就掛載一次，問題會被放大。
  useEffect(() => {
    if (job.data?.status === 'completed') {
      void qc.invalidateQueries({ queryKey: ['analysis', questionId] });
    }
  }, [job.data?.status, qc, questionId]);

  /*
   * 外部訊號**變化**時才啟動分析——掛載時絕對不能觸發。
   *
   * 這個面板帶著 `key={questionId}`，因此每次換題都會重新掛載。
   * 原本只判斷 `startSignal > 0`，於是使用者用過一次快捷鍵之後，
   * 訊號值就一直大於 0：接下來**每換到一題就自動分析那一題**，
   * 看起來就像「分析跑到錯的題目上」。
   *
   * 用 ref 記住掛載當下的值，只有真正變動才動作。
   * ref 的初始值就是掛載時的訊號，因此第一次 effect 必定相等、不觸發。
   */
  const lastStartSignal = useRef(startSignal);
  useEffect(() => {
    if (startSignal === lastStartSignal.current) return;
    lastStartSignal.current = startSignal;
    start.mutate(false);
    // start 是 mutation 物件，每次 render 都是新的參照，放進相依會造成無限迴圈。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSignal]);

  const cancel = useMutation({
    mutationFn: (id: string) => api.post<AiJobResponse>(`/ai/jobs/${id}/cancel`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai-job', jobId] }),
  });

  const startError = start.error instanceof ApiRequestError ? start.error : null;
  const running =
    job.data !== undefined &&
    job.data.status !== 'completed' &&
    job.data.status !== 'failed' &&
    job.data.status !== 'cancelled';

  /**
   * 已經跑了多久。
   *
   * 進度條只有階段與百分比，一個慢的任務跟一個卡住的任務看起來一模一樣。
   * 把經過秒數顯示出來，使用者才判斷得出「還在跑」與「該取消了」。
   */
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const startedAt = job.data?.startedAt;
    if (!startedAt || !running) return;
    const tick = () =>
      setElapsed(Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [job.data?.startedAt, running]);


  const data = analysis.data;

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">AI 解析</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            三階段分析：規劃查證方向 → 搜尋外部資料 → 產生解析。所有引用都指向實際查到的來源。
          </p>
        </div>
        {/* 三顆按鈕在窄螢幕排不下，允許換行；父層已有 flex-wrap 讓整組先掉到下一列。 */}
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <Button
            onClick={() => start.mutate(false)}
            disabled={start.isPending || running}
          >
            {running ? '分析中…' : data ? '重新整理' : '開始 AI 分析'}
          </Button>
          {data && (
            <Button variant="secondary" onClick={() => start.mutate(true)} disabled={running}>
              強制重新分析
            </Button>
          )}
          {/* 跑太久時要有辦法停手，否則只能盯著一個不會動的進度條。 */}
          {running && jobId && (
            <Button
              variant="secondary"
              onClick={() => cancel.mutate(jobId)}
              disabled={cancel.isPending}
            >
              {cancel.isPending ? '取消中…' : '取消'}
            </Button>
          )}
        </div>
      </div>

      {startError && <ErrorBanner message={startError.message} details={startError.details} />}

      {job.data && running && <ProgressBar job={job.data} elapsedSeconds={elapsed} />}

      {job.data?.status === 'failed' && (
        <ErrorBanner
          message={`分析失敗：${job.data.errorMessage ?? '未知原因'}`}
          details={job.data.errorCode ? [{ path: '錯誤碼', message: job.data.errorCode }] : undefined}
        />
      )}

      {job.data?.status === 'completed' && job.data.servedFromCache && (
        <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          內容沒有變動，直接沿用既有解析，本次沒有呼叫模型。
        </p>
      )}

      {!data && !running && analysis.isFetched && (
        <p className="text-sm text-muted-foreground">這一題還沒有 AI 解析。</p>
      )}

      {data && <AnalysisContent data={data} />}
    </Card>
  );
}

/** 超過這個秒數就提醒使用者「比平常久」。實測正常單階段約 7～23 秒。 */
const SLOW_ANALYSIS_SECONDS = 90;

function ProgressBar({ job, elapsedSeconds }: { job: AiJobResponse; elapsedSeconds: number }) {
  const step = AI_PROGRESS_STEPS[job.progressStep];
  const slow = elapsedSeconds >= SLOW_ANALYSIS_SECONDS;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span>{step.label}</span>
        <span className="tabular-nums text-muted-foreground">
          {elapsedSeconds > 0 && `${elapsedSeconds} 秒．`}
          {job.progressPct}%
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-all duration-500"
          style={{ width: `${job.progressPct}%` }}
        />
      </div>
      {slow && (
        <p className="text-xs text-muted-foreground">
          比平常久（通常 30 秒內）。模型可能正在排隊，可以先去做下一題，稍後回來看；
          或直接取消再重跑。
        </p>
      )}
    </div>
  );
}

function AnalysisContent({ data }: { data: QuestionAnalysisResponse }) {
  return (
    <div className="space-y-5">
      {data.isStale && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          題目在產生這份解析之後被修改過，內容不一定還適用。建議重新分析。
        </p>
      )}

      {!data.answerValidation.agreesWithStoredAnswer && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
          <p className="font-medium text-destructive">AI 認為題庫的答案可能有誤</p>
          <p className="mt-1">{data.answerValidation.conflictReason}</p>
          <Link href="/conflicts" className="mt-2 inline-block underline underline-offset-4">
            前往答案爭議審核 →
          </Link>
        </div>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-medium">核心概念</h3>
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{data.coreConcept}</p>
      </section>

      {data.solutionSteps.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">解題步驟</h3>
          <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed">
            {data.solutionSteps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-medium">各選項分析</h3>
        <div className="space-y-1.5">
          {data.optionAnalysis.map((option) => (
            <div
              key={option.key}
              className={cn(
                'rounded-md border px-3 py-2 text-sm',
                option.isCorrect && 'border-emerald-500 bg-emerald-50',
              )}
            >
              <span className="font-medium">{option.key}</span>
              <span className="ml-2">{option.reason}</span>
            </div>
          ))}
        </div>
      </section>

      {data.personalized && (
        <section className="space-y-2 rounded-md bg-muted/40 p-4">
          <h3 className="text-sm font-medium">
            你的作答分析
            {data.personalized.errorTypeName && (
              <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-xs">
                {data.personalized.errorTypeName}
              </span>
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            你選了 {data.personalized.selectedAnswers.join('、') || '（未作答）'}／正確答案{' '}
            {data.personalized.correctAnswers.join('、')}
          </p>
          {data.personalized.whyWrong && (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              {data.personalized.whyWrong}
            </p>
          )}
          {data.personalized.missedConditions.length > 0 && (
            <div className="text-sm">
              <p className="font-medium">忽略的條件</p>
              <ul className="list-disc pl-5">
                {data.personalized.missedConditions.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {data.personalized.reviewSuggestions.length > 0 && (
            <div className="text-sm">
              <p className="font-medium">複習建議</p>
              <ul className="list-disc pl-5">
                {data.personalized.reviewSuggestions.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {data.sources.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">查證來源（{data.sources.length}）</h3>
          <div className="space-y-1.5">
            {data.sources.map((source) => (
              <div key={source.sourceId} className="flex items-start gap-2 text-sm">
                {/*
                  來源編號是給「對照引用」用的，不是重點資訊，因此只用等寬窄標記。
                  同時它也是查看原文的入口：滑上去（觸控裝置是點一下）就能讀到
                  這份來源實際送進模型的內容，不必離開解析頁去翻筆記或開網頁。
                */}
                <HoverPanel
                  label={`查看 ${source.sourceId} 的原文`}
                  panelClassName="w-[min(30rem,calc(100vw-1.5rem))]"
                  triggerClassName={cn(
                    'mt-0.5 w-6 shrink-0 cursor-help text-right font-mono text-[10px] leading-5 tabular-nums underline decoration-dotted underline-offset-2',
                    source.isUsed ? 'text-foreground' : 'text-muted-foreground/60',
                  )}
                  panel={<SourceContent source={source} />}
                >
                  {source.sourceId}
                </HoverPanel>
                <div className="min-w-0 flex-1">
                  {/*
                    筆記沒有 URL，不能渲染成連結。
                    契約把 url 定為可空正是為了讓這件事在型別上就擋住。
                  */}
                  {source.sourceType === 'note' || source.url === null ? (
                    <span className="font-medium">{source.title}</span>
                  ) : (
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-4"
                    >
                      {source.title}
                    </a>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {source.sourceType === 'note' ? (
                      <span className="text-emerald-700 dark:text-emerald-400">你的章節筆記</span>
                    ) : (
                      <>
                        {source.domain} · {TRUST_TIER_LABEL[source.trustTier] ?? source.trustTier}
                      </>
                    )}
                    {source.isUsed ? ' · 已被引用' : ' · 未被引用'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.pendingTagSuggestions.length > 0 && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          AI 提到了系統中沒有的標籤（{data.pendingTagSuggestions.join('、')}），已送入
          <Link href="/tags/suggestions" className="mx-1 underline underline-offset-4">
            標籤建議審核
          </Link>
          等待你確認。AI 不會自行建立標籤。
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        研究模式 {data.researchMode}．信心 {Math.round(data.confidence * 100)}%．模型 {data.model}
        {data.requiresHumanReview && '．⚠ 建議人工複核'}
      </p>
    </div>
  );
}

/**
 * 來源原文的浮動預覽。
 *
 * 顯示的是**實際送進模型的那份內容**（`contentSnippet`），不是原始全文——
 * 使用者看到的必須與 AI 看到的一致，否則「這句話 AI 是從哪裡讀到的」對不起來。
 * 因此內容比原文短時要明說，不能讓人以為這就是整段筆記。
 */
function SourceContent({
  source,
}: {
  source: QuestionAnalysisResponse['sources'][number];
}) {
  const snippet = source.contentSnippet.trim();
  const truncated = source.contentLength !== null && source.contentLength > snippet.length;

  return (
    <div className="space-y-2 text-left">
      <div>
        <p className="text-sm font-medium leading-snug">{source.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {source.sourceType === 'note' ? (
            <span className="text-emerald-700 dark:text-emerald-400">你的章節筆記</span>
          ) : (
            source.domain
          )}
          {' · '}
          {source.isUsed ? '已被引用' : '未被引用'}
        </p>
      </div>

      {snippet === '' ? (
        <p className="text-xs text-muted-foreground">這份來源沒有保存正文。</p>
      ) : (
        <div className="max-h-72 overflow-y-auto rounded border bg-muted/30 p-2">
          <p className="whitespace-pre-wrap text-xs leading-relaxed">{snippet}</p>
        </div>
      )}

      {truncated && (
        <p className="text-[11px] text-muted-foreground">
          以上是送進模型的前 {snippet.length} 字，原文共 {source.contentLength} 字。
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        <span className="hidden sm:inline">滑鼠移入可捲動；點編號可釘住不關。</span>
        <span className="sm:hidden">點編號可開關；點面板外即關閉。</span>
      </p>
    </div>
  );
}
