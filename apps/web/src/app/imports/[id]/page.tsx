'use client';

import type {
  ChapterResponse,
  ImportBatchResponse,
  ImportQuestionResponse,
  SubjectResponse,
} from '@repo/contracts';
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

/** 與 quiz/new 相同的下拉樣式，避免兩處各長一個樣子。 */
const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function PreviewView({ batchId }: { batchId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<string>('');

  // 空字串代表「照檔案內容建立」，那是原本唯一的行為，因此也是預設值。
  const [targetSubjectId, setTargetSubjectId] = useState('');
  const [targetChapterId, setTargetChapterId] = useState('');

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

  const subjects = useQuery({
    queryKey: ['subjects'],
    queryFn: () => api.get<SubjectResponse[]>('/subjects'),
  });

  const chapters = useQuery({
    queryKey: ['subjects', targetSubjectId, 'chapters'],
    queryFn: () => api.get<ChapterResponse[]>(`/subjects/${targetSubjectId}/chapters`),
    enabled: targetSubjectId !== '',
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
    mutationFn: () =>
      api.post<{ committedCount: number }>(`/imports/${batchId}/commit`, {
        // 只送有選的欄位。沒選就維持原本行為：依檔案內容建立或沿用同名科目／章節。
        ...(targetSubjectId ? { targetSubjectId } : {}),
        ...(targetChapterId ? { targetChapterId } : {}),
      }),
    onSuccess: () => {
      refresh();
      void qc.invalidateQueries({ queryKey: ['questions'] });
      router.push('/questions');
    },
  });

  const discard = useMutation({
    mutationFn: () => api.delete(`/imports/${batchId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['imports'] });
      router.push('/imports');
    },
  });

  const commitError = commit.error instanceof ApiRequestError ? commit.error : null;
  const discardError = discard.error instanceof ApiRequestError ? discard.error : null;
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
            {data && data.noteCount > 0 && ` · 章節筆記 ${data.noteCount} 段`}
          </p>
          {/*
            筆記會直接影響 AI 解析的內容，而且是「筆記優先」——
            匯進去了多少必須看得見，否則使用者無從得知解析是依據什麼寫出來的。
          */}
          {data && data.noteCount > 0 && (
            <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
              這批筆記匯入後會成為此題庫的本地資料源，AI 解析時優先採用。
            </p>
          )}
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

      {data?.status !== 'committed' && data?.status !== 'discarded' && (
        <Card className="space-y-4">
          <div>
            <h2 className="font-medium">匯入目標</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              不選就照檔案內容處理：同名科目沿用、沒有就建立。選了科目與章節則寫入指定位置。
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="科目" hint="不選則依檔案的科目名稱">
              <select
                className={selectClass}
                value={targetSubjectId}
                onChange={(e) => {
                  setTargetSubjectId(e.target.value);
                  // 章節屬於科目，換科目就必須清掉，否則會送出跨科目的組合。
                  setTargetChapterId('');
                }}
              >
                <option value="">依檔案內容（{data?.targetSubjectName ?? '新建立'}）</option>
                {subjects.data?.map((subject) => (
                  <option key={subject.id} value={subject.id}>
                    {subject.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="章節" hint={targetSubjectId ? '不選則依檔案的章節名稱' : '請先選擇科目'}>
              <select
                className={selectClass}
                value={targetChapterId}
                disabled={!targetSubjectId}
                onChange={(e) => setTargetChapterId(e.target.value)}
              >
                <option value="">依檔案內容</option>
                {chapters.data?.map((chapter) => (
                  <option key={chapter.id} value={chapter.id}>
                    {chapter.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t pt-4">
            <span className="text-sm">
              {data?.canCommit
                ? '沒有阻斷性錯誤，可以寫入正式題庫。'
                : '仍有題目存在錯誤，請先修正或排除。'}
            </span>
            <div className="ml-auto flex gap-2">
              {/* 不想匯入就要能整批丟掉，否則待確認的批次會一直堆在清單上。 */}
              <Button
                variant="secondary"
                disabled={discard.isPending}
                onClick={() => {
                  if (confirm('確定丟棄這個批次？暫存的題目會一併刪除，正式題庫不受影響。')) {
                    discard.mutate();
                  }
                }}
              >
                {discard.isPending ? '丟棄中…' : '丟棄不匯入'}
              </Button>
              <Button
                disabled={!data?.canCommit || commit.isPending}
                onClick={() => {
                  if (confirm(`確定將 ${data?.validCount} 題寫入正式題庫？`)) commit.mutate();
                }}
              >
                {commit.isPending ? '匯入中…' : '確認匯入'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {commitError && <ErrorBanner message={commitError.message} details={commitError.details} />}
      {discardError && <ErrorBanner message={discardError.message} details={discardError.details} />}

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
