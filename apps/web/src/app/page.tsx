'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { api } from '@/lib/api-client';

/**
 * 進入點：依系統狀態決定去向。
 * 尚未初始化 → /setup；已初始化 → /subjects（未登入時由 AppShell 導向 /login）。
 */
export default function HomePage() {
  const router = useRouter();

  const { data, isError } = useQuery({
    queryKey: ['auth', 'bootstrap-status'],
    queryFn: () => api.get<{ canBootstrap: boolean }>('/auth/bootstrap'),
    retry: false,
  });

  useEffect(() => {
    if (!data) return;
    router.replace(data.canBootstrap ? '/setup' : '/subjects');
  }, [data, router]);

  return (
    <main className="px-6 py-24 text-center">
      {isError ? (
        <div className="mx-auto max-w-md space-y-2">
          <p className="font-medium text-destructive">無法連線到後端 API</p>
          <p className="text-sm text-muted-foreground">
            請確認後端已啟動（<code className="rounded bg-muted px-1">pnpm dev:api</code>）。
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">載入中…</p>
      )}
    </main>
  );
}
