'use client';

import type { ImportBatchResponse } from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { AppShell } from '@/components/app-shell';
import { Button, Card, EmptyState, ErrorBanner } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

export default function ImportsPage() {
  return (
    <AppShell>
      <ImportsView />
    </AppShell>
  );
}

function ImportsView() {
  const router = useRouter();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  const batches = useQuery({
    queryKey: ['imports'],
    queryFn: () => api.get<ImportBatchResponse[]>('/imports'),
  });

  const prompt = useQuery({
    queryKey: ['imports', 'prompt'],
    queryFn: () => api.get<{ prompt: string }>('/imports/prompt'),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      // 上傳走 multipart，因此不經過 api-client 的 JSON 路徑，但仍需帶上 CSRF token。
      const { csrfToken } = await api.get<{ csrfToken: string }>('/auth/csrf');
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API_BASE}/imports`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': csrfToken },
        body: form,
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new ApiRequestError(
          res.status,
          payload?.error?.code ?? 'UNKNOWN',
          payload?.error?.message ?? '上傳失敗',
        );
      }
      return payload as ImportBatchResponse;
    },
    onSuccess: (batch) => {
      void qc.invalidateQueries({ queryKey: ['imports'] });
      router.push(`/imports/${batch.id}`);
    },
  });

  const error = upload.error instanceof ApiRequestError ? upload.error : null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">JSON 匯入</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          上傳後只會進入暫存區並逐題驗證，確認無誤後才寫入正式題庫。
        </p>
      </div>

      <Card className="space-y-4">
        <h2 className="font-medium">步驟 1：用外部 AI 整理 PDF</h2>
        <p className="text-sm text-muted-foreground">
          複製下方 Prompt，連同 PDF 一起交給具備 PDF 閱讀能力的 AI（GPT、Claude 等），
          把輸出結果存成 <code className="rounded bg-muted px-1">.json</code> 檔。
        </p>
        <Button
          type="button"
          variant="secondary"
          disabled={!prompt.data}
          onClick={async () => {
            await navigator.clipboard.writeText(prompt.data!.prompt);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? '已複製到剪貼簿' : '複製 PDF 整理 Prompt'}
        </Button>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">預覽 Prompt 內容</summary>
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
            {prompt.data?.prompt ?? '載入中…'}
          </pre>
        </details>
      </Card>

      <Card className="space-y-4">
        <h2 className="font-medium">步驟 2：上傳 JSON 檔</h2>
        {error && <ErrorBanner message={error.message} details={error.details} />}
        <div className="flex items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm"
          />
          <Button
            type="button"
            disabled={upload.isPending}
            onClick={() => {
              const file = fileRef.current?.files?.[0];
              if (file) upload.mutate(file);
            }}
          >
            {upload.isPending ? '上傳中…' : '上傳並驗證'}
          </Button>
        </div>
      </Card>

      <div className="space-y-3">
        <h2 className="font-medium">匯入紀錄</h2>
        {batches.data?.length === 0 && <EmptyState title="還沒有任何匯入紀錄" />}
        {batches.data?.map((batch) => (
          <Link key={batch.id} href={`/imports/${batch.id}`} className="block">
            <Card className="flex items-center gap-4 transition hover:bg-accent/40">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{batch.filename}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {batch.totalCount} 題 · 錯誤 {batch.errorCount} · 警告 {batch.warningCount}
                  {batch.reviewRequiredCount > 0 && ` · 需複核 ${batch.reviewRequiredCount}`}
                  {' · '}
                  {new Date(batch.createdAt).toLocaleString('zh-TW')}
                </p>
              </div>
              <StatusBadge status={batch.status} />
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    validated: { label: '待確認', className: 'bg-emerald-100 text-emerald-800' },
    partially_valid: { label: '有錯誤', className: 'bg-amber-100 text-amber-800' },
    failed: { label: '驗證失敗', className: 'bg-destructive/10 text-destructive' },
    committed: { label: '已匯入', className: 'bg-secondary text-secondary-foreground' },
    discarded: { label: '已丟棄', className: 'bg-muted text-muted-foreground' },
  };
  const item = map[status] ?? { label: status, className: 'bg-muted text-muted-foreground' };
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs ${item.className}`}>
      {item.label}
    </span>
  );
}
