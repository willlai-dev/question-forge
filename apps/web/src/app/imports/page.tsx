'use client';

import type { ImportBatchResponse } from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { AppShell } from '@/components/app-shell';
import { Button, Card, EmptyState, ErrorBanner } from '@/components/ui';
import { api, ApiRequestError, getCsrfToken, resetCsrfToken } from '@/lib/api-client';

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

  const discard = useMutation({
    mutationFn: (id: string) => api.delete(`/imports/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['imports'] }),
  });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      // 上傳走 multipart，不經過 api-client 的 JSON 路徑，但 CSRF token
      // 必須向 getCsrfToken() 取得 —— 直接呼叫 /auth/csrf 會產生新 token
      // 並覆寫 cookie，讓 api-client 快取的那個立刻失效，後續操作全部 403。
      const csrfToken = await getCsrfToken();
      const form = new FormData();
      // 同一個欄位名稱重複 append 就是多檔；後端以 FilesInterceptor 接收。
      for (const file of files) form.append('file', file);
      const res = await fetch(`${API_BASE}/imports`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': csrfToken },
        body: form,
      });
      const payload = await res.json();
      if (!res.ok) {
        if (payload?.error?.code === 'CSRF_TOKEN_INVALID') resetCsrfToken();
        throw new ApiRequestError(
          res.status,
          payload?.error?.code ?? 'UNKNOWN',
          payload?.error?.message ?? '上傳失敗',
          payload?.error?.details,
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
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">JSON 匯入</h1>
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
          className="w-full sm:w-auto"
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
          <summary className="cursor-pointer py-1 text-muted-foreground">預覽 Prompt 內容</summary>
          {/* prompt 裡有長段的 JSON 範例，一定要允許斷行，否則會撐破卡片。 */}
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
            {prompt.data?.prompt ?? '載入中…'}
          </pre>
        </details>
      </Card>

      <Card className="space-y-4">
        <h2 className="font-medium">步驟 2：上傳 JSON 檔</h2>
        <p className="text-xs text-muted-foreground">
          可一次選多個檔案（例如各章節一份），會合併成同一個批次一起預覽與匯入。
          <strong className="ml-1">多檔時各檔的科目必須相同。</strong>
        </p>
        {error && <ErrorBanner message={error.message} details={error.details} />}
        {/*
          檔案選擇器的寬度由「選擇檔案」按鈕加檔名決定，多選時檔名很長。
          和送出鈕並排會把按鈕擠出畫面，手機一律改成上下排列。
        */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            multiple
            className="min-w-0 flex-1 text-sm file:mr-3 file:min-h-9 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm"
          />
          <Button
            type="button"
            className="w-full shrink-0 sm:w-auto"
            disabled={upload.isPending}
            onClick={() => {
              const files = [...(fileRef.current?.files ?? [])];
              if (files.length > 0) upload.mutate(files);
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
          <Card key={batch.id} className="flex flex-wrap items-center gap-3 sm:gap-4">
            {/*
              整張卡片原本是一個 Link，丟棄按鈕不能放在裡面——
              巢狀在連結內的按鈕點下去會連帶觸發導覽。改成只有內容區是連結。
            */}
            <Link href={`/imports/${batch.id}`} className="w-full min-w-0 flex-1 sm:w-auto">
              <p className="truncate font-medium hover:underline">{batch.filename}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {batch.totalCount} 題 · 錯誤 {batch.errorCount} · 警告 {batch.warningCount}
                {batch.reviewRequiredCount > 0 && ` · 需複核 ${batch.reviewRequiredCount}`}
                {batch.noteCount > 0 && ` · 筆記 ${batch.noteCount} 段`}
                {' · '}
                {new Date(batch.createdAt).toLocaleString('zh-TW')}
              </p>
            </Link>
            <StatusBadge status={batch.status} />
            {/* 已匯入的批次不提供丟棄：那會讓人以為連正式題庫的題目也一起沒了。 */}
            {batch.status !== 'committed' && batch.status !== 'discarded' && (
              <Button
                variant="secondary"
                disabled={discard.isPending}
                onClick={() => {
                  if (confirm(`確定丟棄「${batch.filename}」？正式題庫不受影響。`)) {
                    discard.mutate(batch.id);
                  }
                }}
              >
                丟棄
              </Button>
            )}
          </Card>
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
