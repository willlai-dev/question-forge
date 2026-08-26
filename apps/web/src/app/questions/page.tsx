'use client';

import type { PaginationMeta, QuestionResponse, SubjectResponse } from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { AppShell } from '@/components/app-shell';
import { Button, Card, EmptyState, Input, selectClass } from '@/components/ui';
import { api } from '@/lib/api-client';

export default function QuestionsPage() {
  return (
    <AppShell>
      <QuestionsView />
    </AppShell>
  );
}

function QuestionsView() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({
    q: '',
    subjectId: '',
    type: '',
    reviewRequired: '',
    flagged: '',
    hasExplanation: '',
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const subjects = useQuery({
    queryKey: ['subjects'],
    queryFn: () => api.get<SubjectResponse[]>('/subjects'),
  });

  const params = new URLSearchParams({ page: String(page), pageSize: '20' });
  if (filters.q) params.set('q', filters.q);
  if (filters.subjectId) params.set('subjectId', filters.subjectId);
  if (filters.type) params.set('type', filters.type);
  if (filters.reviewRequired) params.set('reviewRequired', filters.reviewRequired);
  if (filters.flagged) params.set('flagged', filters.flagged);
  if (filters.hasExplanation) params.set('hasExplanation', filters.hasExplanation);

  const questions = useQuery({
    queryKey: ['questions', params.toString()],
    queryFn: () =>
      api.get<{ items: QuestionResponse[]; pagination: PaginationMeta }>(`/questions?${params}`),
  });

  const bulk = useMutation({
    mutationFn: (action: 'delete' | 'setReviewRequired') =>
      api.post('/questions/bulk', {
        questionIds: [...selected],
        action,
        ...(action === 'setReviewRequired' ? { reviewRequired: true } : {}),
      }),
    onSuccess: () => {
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ['questions'] });
    },
  });

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const items = questions.data?.items ?? [];
  const pagination = questions.data?.pagination;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">題目</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            共 {pagination?.total ?? 0} 題
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link href="/imports" className="flex-1 sm:flex-none">
            <Button variant="secondary" className="w-full sm:w-auto">
              JSON 匯入
            </Button>
          </Link>
          <Link href="/questions/new" className="flex-1 sm:flex-none">
            <Button className="w-full sm:w-auto">新增題目</Button>
          </Link>
        </div>
      </div>

      {/*
        六個篩選器用網格排，不是 flex-wrap。
        flex-wrap 會讓每個下拉依內容長度長成不同寬度，折行後參差不齊；
        在手機上更慘——「複核狀態不限」這種長選項會獨佔一整列，
        旁邊留下一大塊空白。網格則保證每列等寬對齊。
      */}
      <Card className="grid grid-cols-1 gap-3 xs:grid-cols-2 lg:grid-cols-3">
        <Input
          className="xs:col-span-2 lg:col-span-1"
          placeholder="搜尋題幹關鍵字"
          value={filters.q}
          onChange={(e) => {
            setPage(1);
            setFilters((f) => ({ ...f, q: e.target.value }));
          }}
        />
        <select
          className={selectClass}
          value={filters.subjectId}
          onChange={(e) => {
            setPage(1);
            setFilters((f) => ({ ...f, subjectId: e.target.value }));
          }}
        >
          <option value="">全部科目</option>
          {subjects.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          className={selectClass}
          value={filters.type}
          onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}
        >
          <option value="">全部題型</option>
          <option value="single_choice">單選題</option>
          <option value="multiple_choice">複選題</option>
        </select>
        <select
          className={selectClass}
          value={filters.reviewRequired}
          onChange={(e) => setFilters((f) => ({ ...f, reviewRequired: e.target.value }))}
        >
          <option value="">複核狀態不限</option>
          <option value="true">需複核</option>
          <option value="false">不需複核</option>
        </select>
        {/*
          個人標記與「需複核」刻意分成兩個篩選器：
          後者是題庫品質（匯入時答案存疑），前者是自己覺得重要，兩件事。
        */}
        <select
          className={selectClass}
          value={filters.flagged}
          onChange={(e) => setFilters((f) => ({ ...f, flagged: e.target.value }))}
        >
          <option value="">重點不限</option>
          <option value="true">只看我標的重點</option>
          <option value="false">未標記</option>
        </select>
        <select
          className={selectClass}
          value={filters.hasExplanation}
          onChange={(e) => setFilters((f) => ({ ...f, hasExplanation: e.target.value }))}
        >
          <option value="">解析不限</option>
          <option value="true">有解析</option>
          <option value="false">缺解析</option>
        </select>
      </Card>

      {selected.size > 0 && (
        <Card className="flex flex-wrap items-center gap-3">
          <span className="w-full text-sm sm:w-auto">已選取 {selected.size} 題</span>
          <Button variant="secondary" onClick={() => bulk.mutate('setReviewRequired')}>
            標記需複核
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (confirm(`確定刪除選取的 ${selected.size} 題？`)) bulk.mutate('delete');
            }}
          >
            批次刪除
          </Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            取消選取
          </Button>
        </Card>
      )}

      {questions.isPending && <p className="text-sm text-muted-foreground">載入中…</p>}
      {items.length === 0 && !questions.isPending && (
        <EmptyState title="沒有符合條件的題目" description="可以手動新增，或用 JSON 匯入整份題庫。" />
      )}

      <div className="space-y-2">
        {items.map((question) => (
          <Card key={question.id} className="flex gap-3 p-4 sm:gap-4">
            {/* 預設的核取方塊約 13px，用手指幾乎點不到，手機上放大到 20px。 */}
            <input
              type="checkbox"
              className="mt-1 h-5 w-5 shrink-0 sm:h-4 sm:w-4"
              checked={selected.has(question.id)}
              onChange={() => toggle(question.id)}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>#{question.questionNumber}</span>
                <span className="rounded bg-secondary px-1.5 py-0.5">
                  {question.type === 'single_choice' ? '單選' : '複選'}
                </span>
                <span>
                  {question.subjectName}
                  {question.chapterName ? ` / ${question.chapterName}` : ''} /{' '}
                  {question.questionGroupName}
                </span>
                {question.mark?.isFlagged && (
                  <span
                    className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800"
                    title={question.mark.note ?? undefined}
                  >
                    ★ 重點
                  </span>
                )}
                {question.mark?.note && !question.mark.isFlagged && (
                  <span className="rounded bg-muted px-1.5 py-0.5" title={question.mark.note}>
                    有註記
                  </span>
                )}
                {question.reviewRequired && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">需複核</span>
                )}
                {!question.explanation && (
                  <span className="rounded bg-muted px-1.5 py-0.5">缺解析</span>
                )}
              </div>
              <p className="mt-1.5 line-clamp-2 text-sm">{question.stem}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                答案：{question.options.filter((o) => o.isCorrect).map((o) => o.key).join('、')}
              </p>
            </div>
            <Link href={`/questions/${question.id}/edit`} className="shrink-0">
              <Button variant="ghost" className="px-2 sm:px-4">
                編輯
              </Button>
            </Link>
          </Card>
        ))}
      </div>

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            上一頁
          </Button>
          <span className="text-sm text-muted-foreground">
            第 {pagination.page} / {pagination.totalPages} 頁
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
