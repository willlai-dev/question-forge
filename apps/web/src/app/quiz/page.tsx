'use client';

import type { PaginationMeta, QuizSessionResponse } from '@repo/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { AppShell } from '@/components/app-shell';
import { Button, Card, EmptyState, selectClass } from '@/components/ui';
import { api } from '@/lib/api-client';
import { QUIZ_MODE_LABEL, QUIZ_STATUS_LABEL } from '@/lib/labels';
import { cn } from '@/lib/utils';

export default function QuizSessionsPage() {
  return (
    <AppShell>
      <QuizSessionsView />
    </AppShell>
  );
}

function QuizSessionsView() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');

  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (status) params.set('status', status);

  const sessions = useQuery({
    queryKey: ['quiz-sessions', params.toString()],
    queryFn: () =>
      api.get<{ items: QuizSessionResponse[]; pagination: PaginationMeta }>(
        `/quiz-sessions?${params}`,
      ),
  });

  const items = sessions.data?.items ?? [];
  const pagination = sessions.data?.pagination;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">作答場次</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            未交卷的場次可以隨時回去接著作答。
          </p>
        </div>
        <Link href="/quiz/new" className="shrink-0">
          <Button className="w-full sm:w-auto">開始作答</Button>
        </Link>
      </div>

      <select
        className={cn(selectClass, 'sm:max-w-xs')}
        value={status}
        onChange={(e) => {
          setStatus(e.target.value);
          setPage(1);
        }}
      >
        <option value="">全部狀態</option>
        <option value="in_progress">進行中</option>
        <option value="submitted">已交卷</option>
        <option value="abandoned">已放棄</option>
      </select>

      {items.length === 0 && (
        <EmptyState title="還沒有作答場次" description="按右上角「開始作答」選一個範圍。" />
      )}

      <div className="space-y-3">
        {items.map((session) => {
          const badge = QUIZ_STATUS_LABEL[session.status]!;
          const href =
            session.status === 'in_progress' ? `/quiz/${session.id}` : `/quiz/${session.id}/result`;
          return (
            <Link key={session.id} href={href} className="block">
              <Card className="flex items-start gap-3 p-4 transition hover:bg-accent/40 sm:items-center sm:gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {QUIZ_MODE_LABEL[session.mode] ?? session.mode}．{session.totalQuestions} 題
                    {session.scopes.length > 0 &&
                      `．${session.scopes
                        .map((scope) => scope.refName ?? '錯題')
                        .join('、')}`}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    已作答 {session.answeredCount} 題
                    {session.correctCount !== null && `．答對 ${session.correctCount} 題`}
                    {session.score !== null && `．得分 ${session.score}`}
                    {session.revealMode === 'after_submit' && '．交卷後顯示答案'}
                    {' · '}
                    {new Date(session.startedAt).toLocaleString('zh-TW')}
                  </p>
                </div>
                <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-xs', badge.className)}>
                  {badge.label}
                </span>
              </Card>
            </Link>
          );
        })}
      </div>

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            上一頁
          </Button>
          <span className="text-muted-foreground">
            {pagination.page} / {pagination.totalPages}
          </span>
          <Button
            variant="secondary"
            disabled={page >= pagination.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            下一頁
          </Button>
        </div>
      )}
    </div>
  );
}
