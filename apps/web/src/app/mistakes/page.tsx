'use client';

import type {
  ErrorTypeResponse,
  KnowledgeTagResponse,
  MistakeResponse,
  MistakeStatsResponse,
  PaginationMeta,
  QuizSessionResponse,
  SubjectResponse,
} from '@repo/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { AppShell } from '@/components/app-shell';
import { Button, Card, EmptyState, ErrorBanner } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';
import { MASTERY_LABEL } from '@/lib/labels';
import { cn } from '@/lib/utils';

export default function MistakesPage() {
  return (
    <AppShell>
      <MistakesView />
    </AppShell>
  );
}

const selectClass =
  'h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function MistakesView() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [subjectId, setSubjectId] = useState('');
  const [masteryState, setMasteryState] = useState('');
  const [knowledgeTagId, setKnowledgeTagId] = useState('');
  const [errorTypeId, setErrorTypeId] = useState('');

  const subjects = useQuery({
    queryKey: ['subjects'],
    queryFn: () => api.get<SubjectResponse[]>('/subjects'),
  });

  const knowledgeTags = useQuery({
    queryKey: ['knowledge-tags', 'active'],
    queryFn: () =>
      api.get<{ items: KnowledgeTagResponse[]; pagination: PaginationMeta }>(
        '/knowledge-tags?pageSize=100&status=active',
      ),
  });

  const errorTypes = useQuery({
    queryKey: ['error-types'],
    queryFn: () => api.get<ErrorTypeResponse[]>('/error-types'),
  });

  const stats = useQuery({
    queryKey: ['mistakes', 'stats'],
    queryFn: () => api.get<MistakeStatsResponse>('/mistakes/stats'),
  });

  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (subjectId) params.set('subjectId', subjectId);
  if (masteryState) params.set('masteryState', masteryState);
  if (knowledgeTagId) params.set('knowledgeTagId', knowledgeTagId);
  if (errorTypeId) params.set('errorTypeId', errorTypeId);

  const mistakes = useQuery({
    queryKey: ['mistakes', params.toString()],
    queryFn: () =>
      api.get<{ items: MistakeResponse[]; pagination: PaginationMeta }>(`/mistakes?${params}`),
  });

  const practice = useMutation({
    mutationFn: () =>
      api.post<QuizSessionResponse>('/mistakes/practice', {
        ...(knowledgeTagId ? { knowledgeTagId } : subjectId ? { subjectId } : {}),
        ...(masteryState ? { masteryStates: [masteryState] } : {}),
        orderStrategy: 'random',
        shuffleOptions: true,
        revealMode: 'immediate',
        allowAnswerChange: true,
      }),
    onSuccess: (session) => router.push(`/quiz/${session.id}`),
  });

  const items = mistakes.data?.items ?? [];
  const pagination = mistakes.data?.pagination;
  const error = practice.error instanceof ApiRequestError ? practice.error : null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">錯題本</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            答對一次不會刪除紀錄，只會改變熟練狀態；連續答對三次才算掌握。
          </p>
        </div>
        <Button onClick={() => practice.mutate()} disabled={practice.isPending || items.length === 0}>
          {practice.isPending ? '出題中…' : '依目前篩選重新練習'}
        </Button>
      </div>

      {error && <ErrorBanner message={error.message} details={error.details} />}

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="錯題總數" value={stats.data?.total ?? 0} />
        <Stat label="尚未掌握" value={stats.data?.active ?? 0} />
        <Stat label="進步中" value={stats.data?.improving ?? 0} />
        <Stat label="已掌握" value={stats.data?.mastered ?? 0} />
      </div>

      <div className="flex flex-wrap gap-2">
        <select
          className={selectClass}
          value={subjectId}
          onChange={(e) => {
            setSubjectId(e.target.value);
            setPage(1);
          }}
        >
          <option value="">全部科目</option>
          {subjects.data?.map((subject) => (
            <option key={subject.id} value={subject.id}>
              {subject.name}
            </option>
          ))}
        </select>
        <select
          className={selectClass}
          value={masteryState}
          onChange={(e) => {
            setMasteryState(e.target.value);
            setPage(1);
          }}
        >
          <option value="">全部狀態</option>
          <option value="active">尚未掌握</option>
          <option value="improving">進步中</option>
          <option value="mastered">已掌握</option>
        </select>
        <select
          className={selectClass}
          value={knowledgeTagId}
          onChange={(e) => {
            setKnowledgeTagId(e.target.value);
            setPage(1);
          }}
        >
          <option value="">全部知識點</option>
          {knowledgeTags.data?.items.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
        <select
          className={selectClass}
          value={errorTypeId}
          onChange={(e) => {
            setErrorTypeId(e.target.value);
            setPage(1);
          }}
        >
          <option value="">全部錯誤類型</option>
          {errorTypes.data?.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
      </div>

      {items.length === 0 && (
        <EmptyState
          title="錯題本是空的"
          description="答錯的題目會自動出現在這裡，不需要手動加入。"
        />
      )}

      <div className="space-y-3">
        {items.map((item) => {
          const badge = MASTERY_LABEL[item.masteryState]!;
          return (
            <Link key={item.questionId} href={`/mistakes/${item.questionId}`} className="block">
              <Card className="space-y-2 transition hover:bg-accent/40">
                <div className="flex items-start justify-between gap-4">
                  <p className="min-w-0 flex-1 line-clamp-2 text-sm leading-relaxed">{item.stem}</p>
                  <span
                    className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-xs', badge.className)}
                  >
                    {badge.label}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {item.subjectName}
                  {item.chapterName ? ` · ${item.chapterName}` : ''} · {item.questionGroupName} ·
                  答錯 {item.mistakeCount} 次 · 連續答對 {item.consecutiveCorrect} 次
                  {item.lastMissedAt &&
                    ` · 最近答錯 ${new Date(item.lastMissedAt).toLocaleDateString('zh-TW')}`}
                </p>
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </Card>
  );
}
