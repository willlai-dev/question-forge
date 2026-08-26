'use client';

import type { ErrorTypeResponse, MistakeDetailResponse } from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { AiAnalysisPanel } from '@/components/ai-analysis-panel';
import { AppShell } from '@/components/app-shell';
import { Button, Card, ErrorBanner } from '@/components/ui';
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
  const qc = useQueryClient();
  const [selectedErrorTypes, setSelectedErrorTypes] = useState<string[]>([]);

  const detail = useQuery({
    queryKey: ['mistakes', params.questionId],
    queryFn: () => api.get<MistakeDetailResponse>(`/mistakes/${params.questionId}`),
    retry: false,
  });

  const errorTypes = useQuery({
    queryKey: ['error-types'],
    queryFn: () => api.get<ErrorTypeResponse[]>('/error-types'),
  });

  useEffect(() => {
    if (!detail.data) return;
    setSelectedErrorTypes(
      detail.data.errorTypes.filter((t) => t.source === 'manual').map((t) => t.errorTypeId),
    );
  }, [detail.data]);

  const saveErrorTypes = useMutation({
    mutationFn: () =>
      api.put(`/mistakes/${params.questionId}/error-types`, { errorTypeIds: selectedErrorTypes }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['mistakes'] }),
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
        <div className="mt-3 flex items-start justify-between gap-3 sm:gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-bold tracking-tight sm:text-xl">錯題詳情</h1>
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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
                'flex items-start gap-2 rounded-md border px-3 py-2 text-sm sm:gap-3',
                option.isCorrect && 'border-emerald-500 bg-emerald-50',
              )}
            >
              <span className="shrink-0 font-medium">{option.key}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap">{option.text}</span>
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

        {data.knowledgeTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">知識點：</span>
            {data.knowledgeTags.map((tag) => (
              <span
                key={tag.id}
                className={cn(
                  'rounded-full px-2.5 py-0.5',
                  tag.role === 'primary' ? 'bg-secondary' : 'bg-muted text-muted-foreground',
                )}
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}
      </Card>

      <Card className="space-y-3">
        <div>
          <h2 className="font-medium">錯誤類型</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            標記錯的原因，之後可以在錯題本依此篩選。Phase 4 的 AI 分析也會寫入這裡。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {errorTypes.data?.map((type) => {
            const active = selectedErrorTypes.includes(type.id);
            return (
              <button
                key={type.id}
                type="button"
                title={type.description ?? undefined}
                onClick={() =>
                  setSelectedErrorTypes((prev) =>
                    prev.includes(type.id)
                      ? prev.filter((id) => id !== type.id)
                      : [...prev, type.id],
                  )
                }
                className={cn(
                  // 錯誤類型是一整排小膠囊，最容易點錯的地方；手機上高度拉到 min-h-10。
                  'min-h-10 rounded-full border px-3 py-1 text-sm transition sm:min-h-0',
                  active ? 'border-primary bg-accent font-medium' : 'hover:bg-accent/50',
                )}
              >
                {type.name}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            className="w-full sm:w-auto"
            onClick={() => saveErrorTypes.mutate()}
            disabled={saveErrorTypes.isPending}
          >
            {saveErrorTypes.isPending ? '儲存中…' : '儲存錯誤類型'}
          </Button>
          {data.errorTypes.some((t) => t.source === 'ai') && (
            <span className="text-xs text-muted-foreground">
              AI 標記的項目會保留，不會被這裡的儲存覆蓋
            </span>
          )}
        </div>
      </Card>

      <AiAnalysisPanel
        questionId={params.questionId}
        userAnswerId={data.attempts.find((a) => !a.isCorrect)?.answerId ?? null}
      />

      <div className="space-y-3">
        <h2 className="font-medium">歷次作答</h2>
        {data.attempts.map((attempt) => (
          <Card
            key={attempt.answerId}
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-4 text-sm"
          >
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
            {/* 時間戳在窄螢幕自成一列，不要用 ml-auto 硬推到同一列的右端。 */}
            <span className="w-full text-xs text-muted-foreground sm:ml-auto sm:w-auto">
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
