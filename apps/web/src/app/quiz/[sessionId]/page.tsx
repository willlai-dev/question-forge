'use client';

import {
  findNextUnanswered,
  type QuizOutlineResponse,
  type QuizQuestionResponse,
  type QuizSessionResponse,
  type SubmitAnswerResponse,
} from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { AiAnalysisPanel } from '@/components/ai-analysis-panel';
import { AppShell } from '@/components/app-shell';
import { QuestionMarkControl } from '@/components/question-mark-control';
import { QuestionNavigator } from '@/components/question-navigator';
import { Button, Card, ErrorBanner } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export default function QuizSessionPage() {
  return (
    <AppShell>
      <QuizSessionView />
    </AppShell>
  );
}

function QuizSessionView() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;
  const router = useRouter();
  const qc = useQueryClient();

  const [position, setPosition] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState(() => Date.now());

  const session = useQuery({
    queryKey: ['quiz-session', sessionId],
    queryFn: () => api.get<QuizSessionResponse>(`/quiz-sessions/${sessionId}`),
  });

  // 與 QuestionNavigator 共用同一個 query key，因此不會多打一次請求。
  const outline = useQuery({
    queryKey: ['quiz-session', sessionId, 'outline'],
    queryFn: () => api.get<QuizOutlineResponse>(`/quiz-sessions/${sessionId}/outline`),
    staleTime: 30_000,
  });

  const question = useQuery({
    queryKey: ['quiz-session', sessionId, 'question', position],
    queryFn: () =>
      api.get<QuizQuestionResponse>(`/quiz-sessions/${sessionId}/questions/${position}`),
  });

  // 切題時把畫面狀態重設為該題既有的作答，並重新開始計時。
  useEffect(() => {
    setSelected(question.data?.answer?.selectedAnswers ?? []);
    setStartedAt(Date.now());
  }, [question.data?.sessionQuestionId, question.data?.answer?.selectedAnswers]);

  const answer = useMutation({
    mutationFn: (): Promise<SubmitAnswerResponse> =>
      api.post<SubmitAnswerResponse>(`/quiz-sessions/${sessionId}/answers`, {
        sessionQuestionId: question.data!.sessionQuestionId,
        selectedAnswers: selected,
        responseTimeMs: Date.now() - startedAt,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['quiz-session', sessionId] });
    },
  });

  const submit = useMutation({
    mutationFn: (scoringMode: 'all_questions' | 'answered_only') =>
      api.post(`/quiz-sessions/${sessionId}/submit`, { scoringMode }),
    onSuccess: () => router.push(`/quiz/${sessionId}/result`),
  });

  // 還有題目沒作答時先問計分方式；全部作答完的話兩種算法結果相同，不需要多問一步。
  const [confirmingSubmit, setConfirmingSubmit] = useState(false);

  const data = question.data;
  const total = session.data?.totalQuestions ?? data?.totalQuestions ?? 0;
  const reveal = data?.reveal ?? null;
  const isMultiple = data?.type === 'multiple_choice';
  const answeredCount = session.data?.answeredCount ?? 0;
  const unansweredCount = Math.max(0, total - answeredCount);
  const error =
    answer.error instanceof ApiRequestError
      ? answer.error
      : submit.error instanceof ApiRequestError
        ? submit.error
        : null;

  const toggleOption = (key: string) => {
    if (isMultiple) {
      setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
    } else {
      setSelected([key]);
    }
  };

  // 由快捷鍵觸發 AI 分析。用遞增數字而非 boolean：
  // boolean 只能表達「要不要」，連按兩次時第二次不會有反應。
  const [analyzeSignal, setAnalyzeSignal] = useState(0);

  // Hook 必須在任何提前 return 之前呼叫。
  // 放在下面那個「場次已結束」的分支之後，會讓場次結束時的 hook 數量與
  // 進行中時不同，React 會直接拋錯——而那個分支平常跑不到，很容易漏掉。
  const pending = useQuizKeyboard({
    position,
    total,
    optionKeys: data?.options.map((o) => o.key) ?? [],
    canSubmit: selected.length > 0 && !answer.isPending,
    // reveal 為 null 代表交卷後模式且尚未交卷，此時分析入口本來就不存在。
    canAnalyze: reveal !== null,
    onJump: setPosition,
    onJumpNextUnanswered: () => {
      const next = findNextUnanswered(outline.data?.items ?? [], position);
      if (next !== null) setPosition(next);
    },
    onPickOption: (key) => toggleOption(key),
    onSubmitAnswer: () => answer.mutate(),
    onAnalyze: () => setAnalyzeSignal((n) => n + 1),
  });

  if (session.data && session.data.status !== 'in_progress') {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">此場次已結束。</p>
        <Button onClick={() => router.push(`/quiz/${sessionId}/result`)}>查看結果</Button>
      </div>
    );
  }


  return (
    <div className="space-y-5 sm:space-y-6">
      {/*
        手機上標題與操作分成兩列：導覽鈕加交卷鈕擠在標題右邊會被壓成
        兩個窄到看不出字的方塊。改成標題一列、操作一列，寬度就夠了。
      */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-lg font-bold tracking-tight sm:text-xl">
            第 {position} / {total} 題
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            已作答 {session.data?.answeredCount ?? 0} 題
            {session.data?.revealMode === 'after_submit'
              ? '．交卷後才顯示答案'
              : '．作答後立即顯示答案'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <QuestionNavigator sessionId={sessionId} position={position} onJump={setPosition} />
          <Button
            variant="secondary"
            className="shrink-0"
            onClick={() => {
              if (unansweredCount > 0) setConfirmingSubmit(true);
              else submit.mutate('all_questions');
            }}
            disabled={submit.isPending}
          >
            {submit.isPending ? '交卷中…' : '交卷'}
          </Button>
        </div>
      </div>

      {confirmingSubmit && (
        <Card>
          <h2 className="text-base font-semibold">還有 {unansweredCount} 題沒有作答</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            選擇這一場的分數要怎麼算。無論選哪一個，
            <strong className="font-medium">未作答的題目都不會進入錯題本或學習診斷</strong>
            ——那些統計本來就只看實際作答的紀錄。這裡只影響這一場的分數。
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              className="rounded-md border p-3 text-left transition-colors hover:border-primary hover:bg-muted/40"
              onClick={() => submit.mutate('answered_only')}
              disabled={submit.isPending}
            >
              <span className="block text-sm font-medium">只算我作答的部分</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                分母是已作答的 {answeredCount} 題。時間不夠提早交卷時用這個。
              </span>
            </button>

            <button
              type="button"
              className="rounded-md border p-3 text-left transition-colors hover:border-primary hover:bg-muted/40"
              onClick={() => submit.mutate('all_questions')}
              disabled={submit.isPending}
            >
              <span className="block text-sm font-medium">未作答算答錯</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                分母是全部 {total} 題。模擬考的算法。
              </span>
            </button>
          </div>

          <div className="mt-3">
            <Button variant="secondary" onClick={() => setConfirmingSubmit(false)}>
              先不交卷
            </Button>
          </div>
        </Card>
      )}

      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${total === 0 ? 0 : (position / total) * 100}%` }}
        />
      </div>

      {/*
        暫存指令一定要看得見。按了 M 之後數字鍵的意義就變了，
        沒有提示的話使用者只會覺得「選項怎麼選不動」。
      */}
      {/*
        手機的底部有固定的上一題／下一題列，提示要往上讓開，
        否則兩者會疊在一起互相遮住。桌機沒有那條列，維持原本的位置。
      */}
      {pending.kind !== 'none' && (
        <div className="fixed bottom-20 left-1/2 z-40 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-full border bg-background px-4 py-2 text-center text-sm shadow-lg sm:bottom-4">
          {pending.kind === 'jump' ? (
            <>
              {pending.digits === '' ? (
                <>
                  輸入題號
                  <span className="ml-2 text-xs text-muted-foreground">
                    直接按 M 或 Enter 跳到最近未作答．Esc 取消
                  </span>
                </>
              ) : (
                <>
                  跳到第 <span className="font-mono font-medium">{pending.digits}</span> 題
                  <span className="ml-2 text-xs text-muted-foreground">
                    Enter 或 M 前往．Esc 取消
                  </span>
                </>
              )}
            </>
          ) : (
            <>
              AI 分析
              <span className="ml-2 text-xs text-muted-foreground">Enter 確認．Esc 取消</span>
            </>
          )}
        </div>
      )}

      {error && <ErrorBanner message={error.message} details={error.details} />}

      {data && (
        <Card className="space-y-5">
          <div>
            <p className="text-xs text-muted-foreground">
              {data.subjectName}
              {data.chapterName ? ` · ${data.chapterName}` : ''} · {data.questionGroupName} · 第{' '}
              {data.questionNumber} 題
              {isMultiple && ' · 複選'}
            </p>
            <p className="mt-2 whitespace-pre-wrap leading-relaxed">{data.stem}</p>
          </div>

          <div className="space-y-2">
            {data.options.map((option, index) => {
              const picked = selected.includes(option.key);
              const isAnswerKey = reveal?.correctAnswers.includes(option.key) ?? false;
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => toggleOption(option.key)}
                  className={cn(
                    // 選項是這一頁最主要的點擊目標，手機上內距要夠：
                    // min-h-11 保證即使選項只有一兩個字也還是按得到。
                    'flex w-full items-start gap-2 rounded-md border px-3 py-3 text-left text-sm transition sm:gap-3 sm:px-4',
                    'min-h-11',
                    picked ? 'border-primary bg-accent' : 'hover:bg-accent/50',
                    // 只有在後端真的回傳 reveal 時才上色 —— 前端不自行推測答案。
                    reveal && isAnswerKey && 'border-emerald-500 bg-emerald-50',
                    reveal && picked && !isAnswerKey && 'border-destructive bg-destructive/5',
                  )}
                >
                  {/*
                    數字鍵對應的是畫面順序，因此提示也放在畫面順序上。
                    手機沒有實體鍵盤，這個提示只是在吃掉本來就不夠的寬度，因此隱藏。
                  */}
                  <span className="hidden w-4 shrink-0 font-mono text-xs text-muted-foreground sm:inline">
                    {index < 9 ? index + 1 : ''}
                  </span>
                  <span className="shrink-0 font-medium">{option.key}</span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap">{option.text}</span>
                </button>
              );
            })}
          </div>

          {/*
            標記與註記放在作答區塊裡，而且**不受 reveal 限制**：
            標記自己的想法不會洩漏答案，交卷前正是最想標記的時刻。
          */}
          <QuestionMarkControl questionId={data.questionId} mark={data.mark} />

          <div className="flex flex-wrap items-center gap-3">
            <Button
              className="w-full sm:w-auto"
              onClick={() => answer.mutate()}
              disabled={selected.length === 0 || answer.isPending}
            >
              {answer.isPending ? '送出中…' : data.answer ? '更新答案' : '送出答案'}
            </Button>
            {data.answer && !reveal && (
              <span className="text-sm text-muted-foreground">已作答，交卷後才會顯示答案</span>
            )}
          </div>

          {reveal && (
            <div className="space-y-2 rounded-md border bg-muted/40 p-4 text-sm">
              <p className={reveal.isCorrect ? 'font-medium text-emerald-700' : 'font-medium text-destructive'}>
                {reveal.isCorrect ? '答對了' : '答錯了'}．正確答案：
                {reveal.correctAnswers.join('、')}
              </p>
              {/*
                這題的答案正在爭議待審，判定是拿一個系統自己都認為可能有誤的答案算出來的。
                不講清楚的話，使用者會以為自己確實答錯了。
              */}
              {reveal.isProvisional && (
                <p className="rounded bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-400">
                  這一題的答案正在爭議待審，上面的判定僅供參考，不會計入能力診斷。
                </p>
              )}
              {reveal.explanation ? (
                <p className="whitespace-pre-wrap leading-relaxed">{reveal.explanation}</p>
              ) : (
                <p className="text-muted-foreground">
                  這一題沒有解析——題庫裡沒有的東西，系統不會自己編。需要的話用下方的 AI 深度解析。
                </p>
              )}
            </div>
          )}

          {/*
            即時 AI 深度解析。
            **只在 reveal 存在時顯示**——reveal 為 null 代表這是交卷後對答案的場次
            且還沒交卷，此時連分析入口都不該出現，否則等於繞過防洩漏機制。
            面板本身要按下按鈕才會呼叫模型，不會自動消耗額度。
          */}
          {reveal && (
            <AiAnalysisPanel
              // key 一定要帶：這一頁換題只是改 position，元件不會卸載。
              // 沒有 key 的話 React 會沿用同一個實例，上一題的 jobId 會留在
              // state 裡，換到下一題後進度條顯示的其實是上一題的任務。
              key={data.questionId}
              questionId={data.questionId}
              userAnswerId={data.answer?.answerId}
              startSignal={analyzeSignal}
            />
          )}
        </Card>
      )}

      {/*
        換題列在手機上固定在底部。
        題目 + 選項 + AI 解析加起來動輒好幾屏，換題鈕跟著捲到最下面的話，
        每答完一題都得先把整頁捲到底才能繼續——那是作答時最頻繁的動作。
        桌機維持原本的靜態排列（有鍵盤方向鍵，不需要常駐按鈕）。
      */}
      <div
        className={cn(
          'sticky bottom-0 z-20 -mx-4 flex items-center justify-between gap-3 border-t bg-background/95 px-4 pb-safe pt-3 backdrop-blur',
          'sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:pb-0 sm:pt-0 sm:backdrop-blur-none',
        )}
      >
        <Button
          variant="secondary"
          className="min-w-24 flex-1 sm:flex-none"
          disabled={position <= 1}
          onClick={() => setPosition((p) => p - 1)}
        >
          上一題
        </Button>
        {/* 快捷鍵說明對沒有實體鍵盤的裝置沒有意義，只會佔掉版面。 */}
        <span className="hidden text-xs text-muted-foreground sm:inline">
          ←↑ / →↓ 換題．數字選選項．Enter 送出．E→Enter 分析．M→題號→Enter 跳題．M→M 跳未作答
        </span>
        <span className="text-xs tabular-nums text-muted-foreground sm:hidden">
          {position} / {total}
        </span>
        <Button
          variant="secondary"
          className="min-w-24 flex-1 sm:flex-none"
          disabled={position >= total}
          onClick={() => setPosition((p) => p + 1)}
        >
          下一題
        </Button>
      </div>
    </div>
  );
}

/**
 * 作答頁的鍵盤操作。
 *
 * 這是一個有「暫存指令」的小型模式系統，因此**一定要有畫面提示**：
 * 按了 M 之後數字鍵的意義就變了，沒有提示的話使用者只會覺得選項選不動。
 * 回傳值就是給畫面顯示用的。
 *
 * 三個共同守則（與方向鍵同一套）：
 *   1. 正在輸入時完全不攔——註記的 textarea 就在同一頁。
 *   2. 帶修飾鍵時不攔，不弄壞瀏覽器與系統既有的快捷鍵。
 *   3. 只在真的處理了才 preventDefault。
 */
export type PendingCommand =
  | { kind: 'none' }
  | { kind: 'jump'; digits: string }
  | { kind: 'analyze' };

function useQuizKeyboard(options: {
  position: number;
  total: number;
  optionKeys: string[];
  canSubmit: boolean;
  canAnalyze: boolean;
  onJump: (position: number) => void;
  /** 沒有輸入題號就結束跳題模式時，跳到最近一個尚未作答的題目。 */
  onJumpNextUnanswered: () => void;
  onPickOption: (key: string) => void;
  onSubmitAnswer: () => void;
  onAnalyze: () => void;
}): PendingCommand {
  const [pending, setPendingState] = useState<PendingCommand>({ kind: 'none' });

  /*
   * 暫存指令同時放在 ref 與 state。
   *
   * ref 給事件處理器讀（要同步、且不能讓監聽器隨狀態重掛），state 給畫面顯示。
   * **不能用 setState 的 updater 函式來做這件事**：那個函式必須是純的，
   * 在裡面呼叫 onJump 之類的副作用，StrictMode 下會被執行兩次——
   * 按一次 Enter 跳兩題，而且只在開發模式出現。
   */
  const pendingRef = useRef<PendingCommand>({ kind: 'none' });
  const setPending = (next: PendingCommand): void => {
    pendingRef.current = next;
    setPendingState(next);
  };

  // 每次 render 都會拿到新的 callback，用 ref 保存才不必放進相依，
  // 否則監聽器會不斷被卸載重掛。
  const latest = useRef(options);
  latest.current = options;

  /*
   * 換題就取消暫存指令。
   *
   * 暫存指令的語意是「我接下來要對**這一題**做什麼」，換題之後就不成立了。
   * 用鍵盤換題時會自然被清掉（那些按鍵會落到取消分支），
   * 但用滑鼠點「下一題」或導覽列跳題不會經過鍵盤處理器——
   * 提示會留在畫面上，然後按 Enter 分析到另一題。
   */
  useEffect(() => {
    setPending({ kind: 'none' });
  }, [options.position]);

  useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isTyping(event.target)) return;

      const current = latest.current;
      const key = event.key;
      const take = (): void => event.preventDefault();

      if (key === 'Escape') {
        if (pendingRef.current.kind !== 'none') take();
        setPending({ kind: 'none' });
        return;
      }

      const mode = pendingRef.current;

      // --- 跳題模式：數字的意義變成題號 ---
      if (mode.kind === 'jump') {
        if (/^[0-9]$/.test(key)) {
          take();
          // 上限 4 位數：題號不會比這更長，也避免無限累積。
          setPending({ kind: 'jump', digits: (mode.digits + key).slice(0, 4) });
          return;
        }
        if (key === 'Backspace') {
          take();
          setPending({ kind: 'jump', digits: mode.digits.slice(0, -1) });
          return;
        }
        if (key === 'Enter' || key === 'm' || key === 'M') {
          take();
          const target = Number(mode.digits);
          setPending({ kind: 'none' });
          if (mode.digits === '') {
            // M 之後直接再按一次 → 跳到最近尚未作答的題目。
            current.onJumpNextUnanswered();
          } else if (target >= 1 && target <= current.total) {
            current.onJump(target);
          }
          return;
        }
        // 其他按鍵取消跳題，並讓它照一般規則繼續處理。
        setPending({ kind: 'none' });
        handleNormal(event, current, take);
        return;
      }

      // --- 分析待確認 ---
      if (mode.kind === 'analyze') {
        if (key === 'Enter') {
          take();
          setPending({ kind: 'none' });
          if (current.canAnalyze) current.onAnalyze();
          return;
        }
        setPending({ kind: 'none' });
        handleNormal(event, current, take);
        return;
      }

      // --- 一般模式 ---
      if (key === 'm' || key === 'M') {
        take();
        setPending({ kind: 'jump', digits: '' });
        return;
      }
      if ((key === 'e' || key === 'E') && current.canAnalyze) {
        take();
        setPending({ kind: 'analyze' });
        return;
      }
      handleNormal(event, current, take);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return pending;
}

/** 一般模式下的按鍵：數字選項、Enter 送出、方向鍵換題。 */
function handleNormal(
  event: KeyboardEvent,
  current: {
    position: number;
    total: number;
    optionKeys: string[];
    canSubmit: boolean;
    onJump: (position: number) => void;
    onPickOption: (key: string) => void;
    onSubmitAnswer: () => void;
  },
  take: () => void,
): void {
  const key = event.key;

  // 數字鍵選選項。選項順序就是畫面上的顯示順序（已套用 option_order）。
  if (/^[1-9]$/.test(key)) {
    const optionKey = current.optionKeys[Number(key) - 1];
    if (optionKey !== undefined) {
      take();
      current.onPickOption(optionKey);
    }
    return;
  }

  if (key === 'Enter') {
    if (current.canSubmit) {
      take();
      current.onSubmitAnswer();
    }
    return;
  }

  const delta =
    key === 'ArrowLeft' || key === 'ArrowUp'
      ? -1
      : key === 'ArrowRight' || key === 'ArrowDown'
        ? 1
        : 0;
  if (delta === 0) return;

  const next = current.position + delta;
  if (next < 1 || next > current.total) return;
  take();
  current.onJump(next);
}
