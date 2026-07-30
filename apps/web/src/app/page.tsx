'use client';

import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '@/lib/api-client';

interface DependencyStatus {
  name: string;
  status: 'up' | 'down';
  latencyMs?: number;
  reason?: string;
}

interface DependenciesReport {
  status: 'ok' | 'degraded';
  checkedAt: string;
  dependencies: DependencyStatus[];
}

/**
 * Phase 0 首頁：系統狀態頁。
 *
 * 這一頁的用途是「端到端驗證」——確認 Next.js → CORS → NestJS → PostgreSQL / Redis
 * 整條鏈路都通。實際的首頁儀表板會在 Phase 2 統計功能完成後取代這一頁。
 */
export default function HomePage() {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ['health', 'deps'],
    queryFn: () => apiFetch<DependenciesReport>('/health/deps'),
    refetchInterval: 10_000,
  });

  return (
    <main className="container mx-auto max-w-3xl px-6 py-16">
      <header className="mb-10">
        <p className="text-sm font-medium text-muted-foreground">Phase 0 · 架構與契約</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">題庫分析系統</h1>
        <p className="mt-3 text-muted-foreground">
          選擇題題庫、作答、對答案與 AI 錯題分析系統。目前已完成架構與契約設計，
          設計文件位於 <code className="rounded bg-muted px-1.5 py-0.5 text-sm">docs/</code>。
        </p>
      </header>

      <section className="rounded-lg border p-6">
        <h2 className="text-lg font-semibold">系統連線狀態</h2>
        <p className="mt-1 text-sm text-muted-foreground">每 10 秒自動更新一次。</p>

        <div className="mt-5 space-y-3">
          {isPending && <p className="text-sm text-muted-foreground">檢查中…</p>}

          {isError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4">
              <p className="text-sm font-medium text-destructive">無法連線到後端 API</p>
              <p className="mt-1 text-sm text-muted-foreground">{(error as Error).message}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                請確認已執行 <code className="rounded bg-muted px-1 py-0.5">pnpm dev:api</code>。
              </p>
            </div>
          )}

          {data?.dependencies.map((dep) => (
            <div
              key={dep.name}
              className="flex items-center justify-between rounded-md border px-4 py-3"
            >
              <span className="font-medium">{dep.name}</span>
              <span className="flex items-center gap-3 text-sm">
                {dep.latencyMs !== undefined && (
                  <span className="text-muted-foreground">{dep.latencyMs} ms</span>
                )}
                {dep.reason && <span className="text-muted-foreground">{dep.reason}</span>}
                <span
                  className={
                    dep.status === 'up'
                      ? 'rounded-full bg-emerald-100 px-2.5 py-0.5 text-emerald-700'
                      : 'rounded-full bg-destructive/10 px-2.5 py-0.5 text-destructive'
                  }
                >
                  {dep.status === 'up' ? '正常' : '異常'}
                </span>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8 rounded-lg border p-6">
        <h2 className="text-lg font-semibold">下一階段</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Phase 1 將實作認證、科目／章節／題組管理、選擇題 CRUD 與 JSON 匯入預覽。
          完整里程碑見 <code className="rounded bg-muted px-1.5 py-0.5">docs/IMPLEMENTATION_PLAN.md</code>。
        </p>
      </section>
    </main>
  );
}
