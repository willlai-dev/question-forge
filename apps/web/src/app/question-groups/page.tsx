'use client';

import type {
  ChapterResponse,
  PaginationMeta,
  QuestionGroupResponse,
  SubjectResponse,
} from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { AppShell } from '@/components/app-shell';
import { Button, Card, EmptyState, ErrorBanner, Field, Input } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';

export default function QuestionGroupsPage() {
  return (
    <AppShell>
      <QuestionGroupsView />
    </AppShell>
  );
}

const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function QuestionGroupsView() {
  const qc = useQueryClient();
  const [filterSubject, setFilterSubject] = useState('');
  const [form, setForm] = useState({ subjectId: '', chapterId: '', name: '', source: '', year: '' });

  const subjects = useQuery({
    queryKey: ['subjects'],
    queryFn: () => api.get<SubjectResponse[]>('/subjects'),
  });

  const chapters = useQuery({
    queryKey: ['chapters', form.subjectId],
    queryFn: () => api.get<ChapterResponse[]>(`/subjects/${form.subjectId}/chapters`),
    enabled: Boolean(form.subjectId),
  });

  const groups = useQuery({
    queryKey: ['question-groups', filterSubject],
    queryFn: () =>
      api.get<{ items: QuestionGroupResponse[]; pagination: PaginationMeta }>(
        `/question-groups?pageSize=50${filterSubject ? `&subjectId=${filterSubject}` : ''}`,
      ),
  });

  const createGroup = useMutation({
    mutationFn: () =>
      api.post<QuestionGroupResponse>('/question-groups', {
        subjectId: form.subjectId,
        chapterId: form.chapterId || null,
        name: form.name.trim(),
        source: form.source.trim() || null,
        year: form.year ? Number(form.year) : null,
      }),
    onSuccess: () => {
      setForm((f) => ({ ...f, name: '', source: '', year: '' }));
      void qc.invalidateQueries({ queryKey: ['question-groups'] });
      void qc.invalidateQueries({ queryKey: ['subjects'] });
    },
  });

  const removeGroup = useMutation({
    mutationFn: (id: string) => api.delete(`/question-groups/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['question-groups'] });
      void qc.invalidateQueries({ queryKey: ['subjects'] });
    },
  });

  const error = createGroup.error instanceof ApiRequestError ? createGroup.error : null;
  const canSubmit = Boolean(form.subjectId && form.name.trim());

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">題組</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          題組必須隸屬科目，章節則為選填。題目將於下一階段加入。
        </p>
      </div>

      <Card>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) createGroup.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="科目（必填）">
              <select
                className={selectClass}
                value={form.subjectId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, subjectId: e.target.value, chapterId: '' }))
                }
              >
                <option value="">請選擇科目</option>
                {subjects.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="章節（選填）">
              <select
                className={selectClass}
                value={form.chapterId}
                disabled={!form.subjectId}
                onChange={(e) => setForm((f) => ({ ...f, chapterId: e.target.value }))}
              >
                <option value="">（不指定章節，直接掛在科目下）</option>
                {chapters.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="題組名稱">
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="112年地方特考三等"
              />
            </Field>
            <Field label="來源（選填）">
              <Input
                value={form.source}
                onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
                placeholder="112年地方特考"
              />
            </Field>
            <Field label="年份（選填）">
              <Input
                type="number"
                value={form.year}
                onChange={(e) => setForm((f) => ({ ...f, year: e.target.value }))}
                placeholder="2023"
              />
            </Field>
          </div>

          {error && <ErrorBanner message={error.message} details={error.details} />}

          <Button type="submit" disabled={!canSubmit || createGroup.isPending}>
            建立題組
          </Button>
        </form>
      </Card>

      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">篩選科目</span>
        <select
          className={`${selectClass} max-w-xs`}
          value={filterSubject}
          onChange={(e) => setFilterSubject(e.target.value)}
        >
          <option value="">全部科目</option>
          {subjects.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {groups.data?.items.length === 0 && <EmptyState title="還沒有任何題組" />}

      <div className="space-y-3">
        {groups.data?.items.map((group) => (
          <Card key={group.id} className="flex items-center gap-4">
            <div className="flex-1">
              <p className="font-medium">{group.name}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {group.subjectName}
                {group.chapterName ? ` · ${group.chapterName}` : ' · 直接隸屬科目'}
                {group.source ? ` · ${group.source}` : ''}
                {group.year ? ` · ${group.year}` : ''} · {group.questionCount} 題
              </p>
            </div>
            <Button
              variant="danger"
              onClick={() => {
                if (confirm(`刪除題組「${group.name}」？其題目會一併隱藏。`)) {
                  removeGroup.mutate(group.id);
                }
              }}
            >
              刪除
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
