'use client';

import type {
  QuizQuestionResponse,
  QuizSessionResponse,
  SubmitAnswerResponse,
} from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

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
    mutationFn: () => api.post(`/quiz-sessions/${sessionId}/submit`),
    onSuccess: () => router.push(`/quiz/${sessionId}/result`),
  });

  const data = question.data;
  const total = session.data?.totalQuestions ?? data?.totalQuestions ?? 0;
  const reveal = data?.reveal ?? null;
  const isMultiple = data?.type === 'multiple_choice';
  const error =
    answer.error instanceof ApiRequestError
      ? answer.error
      : submit.error instanceof ApiRequestError
        ? submit.error
        : null;

  // Hook 必須在任何提前 return 之前呼叫。
  // 放在下面那個「場次已結束」的分支之後，會讓場次結束時的 hook 數量與
  // 進行中時不同，React 會直接拋錯——而那個分支平常跑不到，很容易漏掉。
  useArrowNavigation({ position, total, onChange: setPosition });

  if (session.data && session.data.status !== 'in_progress') {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">此場次已結束。</p>
        <Button onClick={() => router.push(`/quiz/${sessionId}/result`)}>查看結果</Button>
      </div>
    );
  }

  const toggleOption = (key: string) => {
    if (isMultiple) {
      setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
    } else {
      setSelected([key]);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">
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
          <Button variant="secondary" onClick={() => submit.mutate()} disabled={submit.isPending}>
            {submit.isPending ? '交卷中…' : '交卷'}
          </Button>
        </div>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${total === 0 ? 0 : (position / total) * 100}%` }}
        />
      </div>

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
            {data.options.map((option) => {
              const picked = selected.includes(option.key);
              const isAnswerKey = reveal?.correctAnswers.includes(option.key) ?? false;
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => toggleOption(option.key)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-md border px-4 py-3 text-left text-sm transition',
                    picked ? 'border-primary bg-accent' : 'hover:bg-accent/50',
                    // 只有在後端真的回傳 reveal 時才上色 —— 前端不自行推測答案。
                    reveal && isAnswerKey && 'border-emerald-500 bg-emerald-50',
                    reveal && picked && !isAnswerKey && 'border-destructive bg-destructive/5',
                  )}
                >
                  <span className="font-medium">{option.key}</span>
                  <span className="flex-1 whitespace-pre-wrap">{option.text}</span>
                </button>
              );
            })}
          </div>

          {/*
            標記與註記放在作答區塊裡，而且**不受 reveal 限制**：
            標記自己的想法不會洩漏答案，交卷前正是最想標記的時刻。
          */}
          <QuestionMarkControl questionId={data.questionId} mark={data.mark} />

          <div className="flex items-center gap-3">
            <Button
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
            />
          )}
        </Card>
      )}

      <div className="flex items-center justify-between">
        <Button
          variant="secondary"
          disabled={position <= 1}
          onClick={() => setPosition((p) => p - 1)}
        >
          上一題
        </Button>
        <span className="text-xs text-muted-foreground">
          方向鍵 ← ↑ / → ↓ 也可以切換（輸入註記時不受影響）
        </span>
        <Button
          variant="secondary"
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
 * 方向鍵切換題目：← ↑ 上一題，→ ↓ 下一題。
 *
 * 三個必須守住的邊界，少一個就會變成干擾而不是便利：
 *
 *   1. **正在輸入時不能攔。** 註記的 textarea 就在同一頁，
 *      搶走方向鍵會讓游標移不動——那比沒有這個功能更糟。
 *   2. **帶修飾鍵時不能攔。** Alt+← 是瀏覽器的上一頁，Cmd/Ctrl+← 是行首，
 *      攔下來等於把使用者既有的習慣弄壞。
 *   3. **只在真的換題時 preventDefault。** 已經在第一題還按 ←，
 *      應該讓頁面照常捲動，而不是無聲吃掉那個按鍵。
 */
function useArrowNavigation(options: {
  position: number;
  total: number;
  onChange: (position: number) => void;
}): void {
  const { position, total, onChange } = options;

  useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isTyping(event.target)) return;

      const delta =
        event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : event.key === 'ArrowRight' || event.key === 'ArrowDown'
            ? 1
            : 0;
      if (delta === 0) return;

      const next = position + delta;
      if (next < 1 || next > total) return;

      event.preventDefault();
      onChange(next);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [position, total, onChange]);
}
