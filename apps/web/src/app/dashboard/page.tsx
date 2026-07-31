'use client';

import type { StatsOverviewResponse } from '@repo/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { AppShell } from '@/components/app-shell';
import { Button, Card, EmptyState } from '@/components/ui';
import { api } from '@/lib/api-client';
import { QUIZ_MODE_LABEL, QUIZ_STATUS_LABEL } from '@/lib/labels';
import { cn } from '@/lib/utils';

export default function DashboardPage() {
  return (
    <AppShell>
      <DashboardView />
    </AppShell>
  );
}

function DashboardView() {
  const stats = useQuery({
    queryKey: ['stats', 'overview'],
    queryFn: () => api.get<StatsOverviewResponse>('/stats/overview'),
  });

  const data = stats.data;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">學習概況</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            題庫共 {data?.questionCount ?? 0} 題，分布在 {data?.subjectCount ?? 0} 個科目、
            {data?.questionGroupCount ?? 0} 個題組。
          </p>
        </div>
        <Link href="/quiz/new">
          <Button>開始作答</Button>
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="已作答" value={`${data?.answeredCount ?? 0} 題`} />
        <Stat
          label="整體正確率"
          value={data?.accuracy === null || data === undefined ? '—' : `${data.accuracy}%`}
          hint={`答對 ${data?.correctCount ?? 0} 題`}
        />
        <Stat
          label="平均作答時間"
          value={
            !data?.averageResponseTimeMs ? '—' : `${Math.round(data.averageResponseTimeMs / 1000)} 秒`
          }
        />
        <Stat
          label="錯題"
          value={`${data?.mistakeTotal ?? 0}`}
          hint={`尚未掌握 ${data?.mistakeActive ?? 0}．已掌握 ${data?.mistakeMastered ?? 0}`}
        />
      </div>

      {data && data.bySubject.length > 0 && (
        <div className="space-y-3">
          <h2 className="font-medium">各科目表現</h2>
          {data.bySubject.map((subject) => (
            <Card key={subject.subjectId} className="p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{subject.subjectName}</span>
                <span className="tabular-nums text-muted-foreground">
                  {subject.correctCount} / {subject.answeredCount} 題
                  {subject.accuracy !== null && `（${subject.accuracy}%）`}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary"
                  style={{ width: `${subject.accuracy ?? 0}%` }}
                />
              </div>
            </Card>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">近期作答</h2>
          {(data?.mistakeTotal ?? 0) > 0 && (
            <Link
              href="/mistakes"
              className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              前往錯題本 →
            </Link>
          )}
        </div>

        {data && data.recentSessions.length === 0 && (
          <EmptyState
            title="還沒有作答紀錄"
            description="從「開始作答」選一個範圍，就能開始練習。"
          />
        )}

        {data?.recentSessions.map((session) => {
          const badge = QUIZ_STATUS_LABEL[session.status]!;
          const href =
            session.status === 'in_progress'
              ? `/quiz/${session.id}`
              : `/quiz/${session.id}/result`;
          return (
            <Link key={session.id} href={href} className="block">
              <Card className="flex items-center gap-4 p-4 transition hover:bg-accent/40">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {QUIZ_MODE_LABEL[session.mode] ?? session.mode}．{session.totalQuestions} 題
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    已作答 {session.answeredCount} 題
                    {session.correctCount !== null && `．答對 ${session.correctCount} 題`}
                    {session.score !== null && `．得分 ${session.score}`}
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
