'use client';

import type { MistakeDetailResponse } from '@repo/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { AppShell } from '@/components/app-shell';
import { Card, ErrorBanner } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';
import { MASTERY_LABEL } from '@/lib/labels';
import { cn } from '@/lib/utils';

export default function MistakeDetailPage() {
  return (
    <AppShell>
      <MistakeDetailView />
    </AppShell>
  );
}

function MistakeDetailView() {
  const params = useParams<{ questionId: string }>();

  const detail = useQuery({
    queryKey: ['mistakes', params.questionId],
    queryFn: () => api.get<MistakeDetailResponse>(`/mistakes/${params.questionId}`),
    retry: false,
  });

  if (detail.error instanceof ApiRequestError) {
    return <ErrorBanner message={detail.error.message} details={detail.error.details} />;
  }

  const data = detail.data;
  if (!data) return <p className="text-sm text-muted-foreground">載入中…</p>;

  const badge = MASTERY_LABEL[data.masteryState]!;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/mistakes"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← 回錯題本
        </Link>
        <div className="mt-3 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight">錯題詳情</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {data.subjectName}
              {data.chapterName ? ` · ${data.chapterName}` : ''} · {data.questionGroupName} · 第{' '}
              {data.questionNumber} 題
            </p>
          </div>
          <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-xs', badge.className)}>
            {badge.label}
          </span>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="答錯次數" value={String(data.mistakeCount)} />
        <Stat label="連續答對" value={String(data.consecutiveCorrect)} hint="連續三次即為已掌握" />
        <Stat label="總作答次數" value={String(data.totalAttempts)} />
        <Stat
          label="近期正確率"
          value={data.recentAccuracy === null ? '—' : `${Math.round(data.recentAccuracy * 100)}%`}
          hint="最近 10 次"
        />
      </div>

      <Card className="space-y-4">
        <p className="whitespace-pre-wrap leading-relaxed">{data.stem}</p>
        <div className="space-y-1.5">
          {data.options.map((option) => (
            <div
              key={option.key}
              className={cn(
                'flex items-start gap-3 rounded-md border px-3 py-2 text-sm',
                option.isCorrect && 'border-emerald-500 bg-emerald-50',
              )}
            >
              <span className="font-medium">{option.key}</span>
              <span className="flex-1 whitespace-pre-wrap">{option.text}</span>
            </div>
          ))}
        </div>
        {data.explanation ? (
          <div className="rounded-md bg-muted/40 p-3 text-sm">
            <p className="whitespace-pre-wrap leading-relaxed">{data.explanation}</p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            這一題沒有解析。系統不會自動編造 —— AI 解析功能在 Phase 4 提供。
          </p>
        )}
      </Card>

      <div className="space-y-3">
        <h2 className="font-medium">歷次作答</h2>
        {data.attempts.map((attempt) => (
          <Card key={attempt.answerId} className="flex items-center gap-4 p-4 text-sm">
            <span
              className={cn(
                'shrink-0 rounded-full px-2.5 py-0.5 text-xs',
                attempt.isCorrect
                  ? 'bg-emerald-100 text-emerald-800'
                  : 'bg-destructive/10 text-destructive',
              )}
            >
              {attempt.isCorrect ? '答對' : '答錯'}
            </span>
            <span className="text-muted-foreground">
              選了 {attempt.selectedAnswers.join('、')}／正確 {attempt.correctAnswers.join('、')}
            </span>
            <span className="ml-auto text-xs text-muted-foreground">
              {attempt.responseTimeMs !== null &&
                `${Math.round(attempt.responseTimeMs / 1000)} 秒 · `}
              {new Date(attempt.answeredAt).toLocaleString('zh-TW')}
            </span>
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
