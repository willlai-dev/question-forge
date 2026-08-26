'use client';

import { AI_PROGRESS_STEPS, type AiJobResponse, type PaginationMeta } from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { AppShell } from '@/components/app-shell';
import { Button, Card, EmptyState, ErrorBanner } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export default function AiJobsPage() {
  return (
    <AppShell>
      <AiJobsView />
    </AppShell>
  );
}

const JOB_TYPE_LABEL: Record<string, string> = {
  question_analysis: '單題分析',
  aggregate_analysis: '多題整合分析',
  maintenance: '維護作業',
};

const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  pending: { label: '排隊中', className: 'bg-muted text-muted-foreground' },
  active: { label: '執行中', className: 'bg-amber-100 text-amber-800' },
  completed: { label: '已完成', className: 'bg-emerald-100 text-emerald-800' },
  failed: { label: '失敗', className: 'bg-destructive/10 text-destructive' },
  retrying: { label: '重試中', className: 'bg-amber-100 text-amber-800' },
  cancelled: { label: '已取消', className: 'bg-muted text-muted-foreground' },
};

function AiJobsView() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');

  const jobs = useQuery({
    queryKey: ['ai-jobs', status],
    queryFn: () =>
      api.get<{ items: AiJobResponse[]; pagination: PaginationMeta }>(
        `/ai/jobs?pageSize=50${status ? `&status=${status}` : ''}`,
      ),
    // 有任務仍在跑就持續更新，全部結束就停下來。
    refetchInterval: (query) =>
      query.state.data?.items.some((job) => job.status === 'active' || job.status === 'pending')
        ? 2000
        : false,
  });

  const act = useMutation({
    mutationFn: (args: { id: string; action: 'cancel' | 'retry' }) =>
      api.post(`/ai/jobs/${args.id}/${args.action}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai-jobs'] }),
  });

  const error = act.error instanceof ApiRequestError ? act.error : null;
  const items = jobs.data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">AI 任務</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            分析是非同步執行的。失敗的任務可以重跑，執行中的可以取消。
          </p>
        </div>
        <Link href="/ai/usage" className="shrink-0">
          <Button variant="secondary" className="w-full sm:w-auto">
            用量統計
          </Button>
        </Link>
      </div>

      <div className="flex flex-wrap gap-2">
        {[
          { value: '', label: '全部' },
          { value: 'active', label: '執行中' },
          { value: 'completed', label: '已完成' },
          { value: 'failed', label: '失敗' },
        ].map((option) => (
          <Button
            key={option.value}
            variant={status === option.value ? 'primary' : 'secondary'}
            onClick={() => setStatus(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>

      {error && <ErrorBanner message={error.message} details={error.details} />}

      {items.length === 0 && <EmptyState title="還沒有任何 AI 任務" />}

      <div className="space-y-3">
        {items.map((job) => {
          const badge = STATUS_LABEL[job.status]!;
          const step = AI_PROGRESS_STEPS[job.progressStep];
          return (
            <Card key={job.id} className="space-y-3">
              <div className="flex items-start justify-between gap-3 sm:gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {JOB_TYPE_LABEL[job.jobType] ?? job.jobType}
                    {job.servedFromCache && '（命中快取）'}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {step.label} · 優先度 {job.priority} · 嘗試 {job.attempts}/{job.maxAttempts} ·{' '}
                    {new Date(job.createdAt).toLocaleString('zh-TW')}
                  </p>
                </div>
                <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-xs', badge.className)}>
                  {badge.label}
                </span>
              </div>

              {(job.status === 'active' || job.status === 'pending') && (
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${job.progressPct}%` }}
                  />
                </div>
              )}

              {job.errorMessage && (
                <p className="rounded-md bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {job.errorCode}：{job.errorMessage}
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                {job.questionId && (
                  <Link href={`/questions/${job.questionId}/edit`}>
                    <Button variant="ghost">查看題目</Button>
                  </Link>
                )}
                {(job.status === 'active' || job.status === 'pending') && (
                  <Button
                    variant="ghost"
                    onClick={() => act.mutate({ id: job.id, action: 'cancel' })}
                  >
                    取消
                  </Button>
                )}
                {(job.status === 'failed' || job.status === 'cancelled') && (
                  <Button
                    variant="secondary"
                    onClick={() => act.mutate({ id: job.id, action: 'retry' })}
                  >
                    重跑
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
