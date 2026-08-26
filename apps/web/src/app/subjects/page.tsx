'use client';

import type { ChapterResponse, SubjectResponse } from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { AppShell } from '@/components/app-shell';
import { Button, Card, EmptyState, ErrorBanner, Field, Input } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';

export default function SubjectsPage() {
  return (
    <AppShell>
      <SubjectsView />
    </AppShell>
  );
}

function SubjectsView() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const subjects = useQuery({
    queryKey: ['subjects'],
    queryFn: () => api.get<SubjectResponse[]>('/subjects'),
  });

  const createSubject = useMutation({
    mutationFn: (value: string) => api.post<SubjectResponse>('/subjects', { name: value }),
    onSuccess: () => {
      setName('');
      void qc.invalidateQueries({ queryKey: ['subjects'] });
    },
  });

  const removeSubject = useMutation({
    mutationFn: (id: string) => api.delete(`/subjects/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['subjects'] }),
  });

  const error = createSubject.error instanceof ApiRequestError ? createSubject.error : null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">科目與章節</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          章節可以留空——題組允許直接隸屬於科目。
        </p>
      </div>

      <Card>
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) createSubject.mutate(name.trim());
          }}
        >
          <div className="flex-1">
            <Field label="新增科目">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：行政法"
              />
            </Field>
          </div>
          <Button
            type="submit"
            className="w-full sm:w-auto"
            disabled={createSubject.isPending || !name.trim()}
          >
            新增
          </Button>
        </form>
        {error && (
          <div className="mt-4">
            <ErrorBanner message={error.message} details={error.details} />
          </div>
        )}
      </Card>

      {subjects.isPending && <p className="text-sm text-muted-foreground">載入中…</p>}

      {subjects.data?.length === 0 && (
        <EmptyState title="還沒有任何科目" description="從上方新增第一個科目開始建立題庫。" />
      )}

      <div className="space-y-3">
        {subjects.data?.map((subject) => (
          <Card key={subject.id} className="p-0 sm:p-0">
            <div className="flex flex-wrap items-center gap-3 px-4 py-4 sm:gap-4 sm:px-6">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{subject.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {subject.chapterCount} 章節 · {subject.questionGroupCount} 題組 ·{' '}
                  {subject.questionCount} 題
                </p>
              </div>
              {/* 兩顆按鈕在窄螢幕會跟科目名稱擠成一團，讓它們整組折到下一列。 */}
              <div className="flex w-full gap-2 sm:w-auto">
                <Button
                  variant="ghost"
                  className="flex-1 sm:flex-none"
                  onClick={() => setExpanded(expanded === subject.id ? null : subject.id)}
                >
                  {expanded === subject.id ? '收合章節' : '管理章節'}
                </Button>
                <Button
                  variant="danger"
                  className="flex-1 sm:flex-none"
                  onClick={() => {
                    if (confirm(`確定刪除「${subject.name}」？其章節、題組與題目會一併隱藏。`)) {
                      removeSubject.mutate(subject.id);
                    }
                  }}
                >
                  刪除
                </Button>
              </div>
            </div>

            {expanded === subject.id && <ChapterPanel subject={subject} />}
          </Card>
        ))}
      </div>
    </div>
  );
}

function ChapterPanel({ subject }: { subject: SubjectResponse }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');

  const chapters = useQuery({
    queryKey: ['chapters', subject.id],
    queryFn: () => api.get<ChapterResponse[]>(`/subjects/${subject.id}/chapters`),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['chapters', subject.id] });
    void qc.invalidateQueries({ queryKey: ['subjects'] });
  };

  const createChapter = useMutation({
    mutationFn: (value: string) =>
      api.post<ChapterResponse>('/chapters', { subjectId: subject.id, name: value }),
    onSuccess: () => {
      setName('');
      invalidate();
    },
  });

  const removeChapter = useMutation({
    mutationFn: (id: string) => api.delete(`/chapters/${id}`),
    onSuccess: invalidate,
  });

  const error = createChapter.error instanceof ApiRequestError ? createChapter.error : null;

  return (
    <div className="border-t bg-muted/30 px-4 py-4 sm:px-6">
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) createChapter.mutate(name.trim());
        }}
      >
        <div className="flex-1">
          <Field label="新增章節">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：第三章 行政行為"
            />
          </Field>
        </div>
        <Button type="submit" variant="secondary" className="w-full sm:w-auto" disabled={!name.trim()}>
          新增章節
        </Button>
      </form>

      {error && (
        <div className="mt-3">
          <ErrorBanner message={error.message} details={error.details} />
        </div>
      )}

      <ul className="mt-4 space-y-2">
        {chapters.data?.length === 0 && (
          <li className="text-sm text-muted-foreground">
            尚無章節。題組仍可直接建立在此科目下。
          </li>
        )}
        {chapters.data?.map((chapter) => (
          <li
            key={chapter.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-background px-4 py-2"
          >
            <span className="min-w-0 flex-1 text-sm">{chapter.name}</span>
            <span className="text-xs text-muted-foreground">
              {chapter.questionGroupCount} 題組 · {chapter.questionCount} 題
            </span>
            <button
              className="shrink-0 py-1 text-xs text-destructive underline-offset-4 hover:underline"
              onClick={() => {
                if (confirm(`刪除章節「${chapter.name}」？底下的題組會退回直接隸屬科目。`)) {
                  removeChapter.mutate(chapter.id);
                }
              }}
            >
              刪除
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
