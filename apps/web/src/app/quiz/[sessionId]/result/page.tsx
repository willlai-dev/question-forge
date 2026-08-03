'use client';

import type { QuizResultResponse } from '@repo/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { AiAnalysisPanel } from '@/components/ai-analysis-panel';
import { AppShell } from '@/components/app-shell';
import { Button, Card, ErrorBanner } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export default function QuizResultPage() {
  return (
    <AppShell>
      <QuizResultView />
    </AppShell>
  );
}

function QuizResultView() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;

  const result = useQuery({
    queryKey: ['quiz-session', sessionId, 'result'],
    queryFn: () => api.get<QuizResultResponse>(`/quiz-sessions/${sessionId}/result`),
    retry: false,
  });

  if (result.error instanceof ApiRequestError) {
    return (
      <div className="space-y-4">
        <ErrorBanner message={result.error.message} details={result.error.details} />
        <Link href={`/quiz/${sessionId}`}>
          <Button variant="secondary">回到作答</Button>
        </Link>
      </div>
    );
  }

  const data = result.data;
  if (!data) return <p className="text-sm text-muted-foreground">載入中…</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">作答結果</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {new Date(data.session.startedAt).toLocaleString('zh-TW')}
            {data.session.status === 'abandoned' && '（已放棄）'}
          </p>
        </div>
        <Link href="/quiz/new">
          <Button>再練一次</Button>
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="得分" value={`${data.score}`} hint="未作答視同答錯" />
        <Stat label="答對" value={`${data.correctCount} / ${data.totalQuestions}`} />
        <Stat
          label="作答正確率"
          value={`${data.accuracy}%`}
          hint={`未作答 ${data.unansweredCount} 題`}
        />
        <Stat
          label="平均作答時間"
          value={
            data.averageResponseTimeMs === null
              ? '—'
              : `${Math.round(data.averageResponseTimeMs / 1000)} 秒`
          }
          hint={data.durationMs === null ? undefined : `總計 ${formatDuration(data.durationMs)}`}
        />
      </div>

      <div className="space-y-3">
        {data.items.map((item) => (
          <Card key={item.sessionQuestionId} className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">
                  第 {item.position} 題 · {item.subjectName}
                  {item.chapterName ? ` · ${item.chapterName}` : ''} · {item.questionGroupName}
                </p>
                <p className="mt-2 whitespace-pre-wrap leading-relaxed">{item.stem}</p>
              </div>
              <ResultBadge isCorrect={item.isCorrect} />
            </div>

            <div className="space-y-1.5">
              {item.options.map((option) => {
                const picked = item.selectedAnswers?.includes(option.key) ?? false;
                return (
                  <div
                    key={option.key}
                    className={cn(
                      'flex items-start gap-3 rounded-md border px-3 py-2 text-sm',
                      // isCorrect 為 null 代表「還不該揭曉」，不是「這個選項是錯的」。
                      // 少了 === 判斷，未揭曉的題目會把使用者選的那項標成紅色。
                      option.isCorrect === true && 'border-emerald-500 bg-emerald-50',
                      picked && option.isCorrect === false && 'border-destructive bg-destructive/5',
                    )}
                  >
                    <span className="font-medium">{option.key}</span>
                    <span className="flex-1 whitespace-pre-wrap">{option.text}</span>
                    {picked && <span className="shrink-0 text-xs text-muted-foreground">你選的</span>}
                  </div>
                );
              })}
            </div>

            {item.explanation ? (
              <div className="rounded-md bg-muted/40 p-3 text-sm">
                <p className="whitespace-pre-wrap leading-relaxed">{item.explanation}</p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">這一題沒有解析。</p>
            )}

            {/*
              只在這題已經揭曉時提供分析入口。correctAnswers 為 null 代表尚未揭曉，
              那種情況下連入口都不該出現。
            */}
            {item.correctAnswers !== null && (
              <AiAnalysisPanel questionId={item.questionId} userAnswerId={item.answerId} />
            )}

            {item.isCorrect === false && (
              <Link
                href={`/mistakes/${item.questionId}`}
                className="text-sm text-muted-foreground underline-offset-4 hover:underline"
              >
                查看這題的錯題紀錄 →
              </Link>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

function ResultBadge({ isCorrect }: { isCorrect: boolean | null }) {
  if (isCorrect === null) {
    return (
      <span className="shrink-0 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
        未作答
      </span>
    );
  }
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2.5 py-0.5 text-xs',
        isCorrect ? 'bg-emerald-100 text-emerald-800' : 'bg-destructive/10 text-destructive',
      )}
    >
      {isCorrect ? '答對' : '答錯'}
    </span>
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}
