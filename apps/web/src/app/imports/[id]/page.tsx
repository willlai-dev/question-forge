'use client';

import type { ImportBatchResponse, ImportQuestionResponse } from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';

import { AppShell } from '@/components/app-shell';
import { StatusBadge } from '@/app/imports/page';
import { Button, Card, ErrorBanner, Field, Input } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';

export default function ImportPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <AppShell>
      <PreviewView batchId={id} />
    </AppShell>
  );
}

function PreviewView({ batchId }: { batchId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<string>('');

  const batch = useQuery({
    queryKey: ['imports', batchId],
    queryFn: () => api.get<ImportBatchResponse>(`/imports/${batchId}`),
  });

  const rows = useQuery({
    queryKey: ['imports', batchId, 'questions', filter],
    queryFn: () =>
      api.get<ImportQuestionResponse[]>(
        `/imports/${batchId}/questions${filter ? `?status=${filter}` : ''}`,
      ),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['imports', batchId] });
  };

  const exclude = useMutation({
    mutationFn: (rowId: string) =>
      api.post(`/imports/${batchId}/questions/${rowId}/exclude`),
    onSuccess: refresh,
  });

  const commit = useMutation({
    mutationFn: () => api.post<{ committedCount: number }>(`/imports/${batchId}/commit`, {}),
    onSuccess: () => {
      refresh();
      void qc.invalidateQueries({ queryKey: ['questions'] });
      router.push('/questions');
    },
  });

  const commitError = commit.error instanceof ApiRequestError ? commit.error : null;
  const data = batch.data;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold tracking-tight">{data?.filename}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            共 {data?.totalCount ?? 0} 題 · 可匯入 {data?.validCount ?? 0} · 錯誤{' '}
            {data?.errorCount ?? 0} · 警告 {data?.warningCount ?? 0}
            {data && data.reviewRequiredCount > 0 && ` · 需複核 ${data.reviewRequiredCount}`}
          </p>
        </div>
        {data && <StatusBadge status={data.status} />}
      </div>

      {data && data.fileIssues.length > 0 && (
        <Card className="space-y-2 border-destructive/40">
          <h2 className="font-medium text-destructive">檔案層級問題</h2>
          {data.fileIssues.map((issue, i) => (
            <p key={i} className="text-sm">
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{issue.code}</span>{' '}
              {issue.message}
            </p>
          ))}
        </Card>
      )}

      {data?.status !== 'committed' && (
        <Card className="flex flex-wrap items-center gap-3">
          <span className="text-sm">
            {data?.canCommit
              ? '沒有阻斷性錯誤，可以寫入正式題庫。'
              : '仍有題目存在錯誤，請先修正或排除。'}
          </span>
          <Button
            className="ml-auto"
            disabled={!data?.canCommit || commit.isPending}
            onClick={() => {
              if (confirm(`確定將 ${data?.validCount} 題寫入正式題庫？`)) commit.mutate();
            }}
          >
            {commit.isPending ? '匯入中…' : '確認匯入'}
          </Button>
        </Card>
      )}

      {commitError && <ErrorBanner message={commitError.message} details={commitError.details} />}

      <div className="flex flex-wrap gap-2">
        {[
          { value: '', label: '全部' },
          { value: 'error', label: '有錯誤' },
          { value: 'warning', label: '有警告' },
          { value: 'valid', label: '正常' },
          { value: 'excluded', label: '已排除' },
        ].map((tab) => (
          <Button
            key={tab.value}
            variant={filter === tab.value ? 'primary' : 'secondary'}
            onClick={() => setFilter(tab.value)}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      <div className="space-y-3">
        {rows.data?.map((row) => (
          <ImportRow
            key={row.id}
            batchId={batchId}
            row={row}
            readOnly={data?.status === 'committed' || data?.status === 'discarded'}
            onExclude={() => exclude.mutate(row.id)}
            onFixed={refresh}
          />
        ))}
      </div>
    </div>
  );
}

function ImportRow({
  batchId,
  row,
  readOnly,
  onExclude,
  onFixed,
}: {
  batchId: string;
  row: ImportQuestionResponse;
  readOnly: boolean;
  onExclude: () => void;
  onFixed: () => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [stem, setStem] = useState(row.stem ?? '');
  const [questionNumber, setQuestionNumber] = useState(String(row.questionNumber ?? ''));

  const fix = useMutation({
    mutationFn: () =>
      api.patch(`/imports/${batchId}/questions/${row.id}`, {
        stem: stem.trim() || null,
        questionNumber: questionNumber ? Number(questionNumber) : null,
      }),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['imports', batchId] });
      onFixed();
    },
  });

  const errors = row.issues.filter((i) => i.level === 'error');
  const warnings = row.issues.filter((i) => i.level === 'warning');
  const isExcluded = row.status === 'excluded';

  return (
    <Card
      className={`space-y-3 ${
        errors.length > 0 ? 'border-destructive/50' : ''
      } ${isExcluded ? 'opacity-50' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>第 {row.rowIndex + 1} 列</span>
        {row.questionNumber !== null && <span>題號 {row.questionNumber}</span>}
        {row.externalId && <span>{row.externalId}</span>}
        {row.type && (
          <span className="rounded bg-secondary px-1.5 py-0.5">
            {row.type === 'single_choice' ? '單選' : row.type === 'multiple_choice' ? '複選' : row.type}
          </span>
        )}
        {row.reviewRequired && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">
            需人工複核{row.reviewReason ? `：${row.reviewReason}` : ''}
          </span>
        )}
        {isExcluded && <span className="rounded bg-muted px-1.5 py-0.5">已排除</span>}
      </div>

      {editing ? (
        <div className="space-y-3">
          <Field label="題號">
            <Input
              type="number"
              value={questionNumber}
              onChange={(e) => setQuestionNumber(e.target.value)}
            />
          </Field>
          <Field label="題幹">
            <textarea
              className="min-h-20 w-full rounded-md border border-input bg-background p-3 text-sm"
              value={stem}
              onChange={(e) => setStem(e.target.value)}
            />
          </Field>
          <div className="flex gap-2">
            <Button onClick={() => fix.mutate()} disabled={fix.isPending}>
              儲存並重新驗證
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              取消
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm">{row.stem || <span className="text-destructive">（題幹為空）</span>}</p>
      )}

      {row.options && row.options.length > 0 && (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {row.options.map((option) => (
            <li key={option.key}>
              <span className={option.isCorrect ? 'font-medium text-foreground' : ''}>
                {option.key}. {option.text}
                {option.isCorrect && ' ✓'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {!row.explanation && (
        <p className="text-xs text-muted-foreground">此題沒有解析（系統不會自動產生）。</p>
      )}

      {(errors.length > 0 || warnings.length > 0) && (
        <div className="space-y-1 border-t pt-3">
          {errors.map((issue, i) => (
            <p key={`e${i}`} className="text-sm text-destructive">
              <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-xs">{issue.code}</span>{' '}
              {issue.message}
            </p>
          ))}
          {warnings.map((issue, i) => (
            <p key={`w${i}`} className="text-sm text-amber-700">
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs">{issue.code}</span>{' '}
              {issue.message}
            </p>
          ))}
        </div>
      )}

      {!readOnly && !isExcluded && (
        <div className="flex gap-2 border-t pt-3">
          {!editing && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              修正
            </Button>
          )}
          <Button variant="ghost" onClick={onExclude}>
            排除此題
          </Button>
        </div>
      )}
    </Card>
  );
}
