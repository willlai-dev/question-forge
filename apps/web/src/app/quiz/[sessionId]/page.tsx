'use client';

import type {
  QuizQuestionResponse,
  QuizSessionResponse,
  SubmitAnswerResponse,
} from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { AppShell } from '@/components/app-shell';
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

  if (session.data && session.data.status !== 'in_progress') {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">此場次已結束。</p>
        <Button onClick={() => router.push(`/quiz/${sessionId}/result`)}>查看結果</Button>
      </div>
    );
  }

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
        <Button variant="secondary" onClick={() => submit.mutate()} disabled={submit.isPending}>
          {submit.isPending ? '交卷中…' : '交卷'}
        </Button>
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
              {reveal.explanation ? (
                <p className="whitespace-pre-wrap leading-relaxed">{reveal.explanation}</p>
              ) : (
                <p className="text-muted-foreground">這一題沒有解析。</p>
              )}
            </div>
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
