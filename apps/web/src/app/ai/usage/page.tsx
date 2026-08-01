'use client';

import type { AiUsageResponse } from '@repo/contracts';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import { AppShell } from '@/components/app-shell';
import { Button, Card, EmptyState } from '@/components/ui';
import { api } from '@/lib/api-client';

export default function AiUsagePage() {
  return (
    <AppShell>
      <AiUsageView />
    </AppShell>
  );
}

const OPERATION_LABEL: Record<string, string> = {
  research_plan: '① 研究規劃',
  evidence_synthesis: '② 證據整理',
  final_explanation: '③ 最終解析',
  aggregate_analysis: '多題整合分析',
};

const STATUS_LABEL: Record<string, string> = {
  success: '成功',
  schema_invalid: '結構不符',
  semantic_invalid: '語意矛盾',
  rate_limited: '被限流',
  http_error: '連線錯誤',
  timeout: '逾時',
  cancelled: '已取消',
};

function AiUsageView() {
  const usage = useQuery({
    queryKey: ['ai-usage'],
    queryFn: () => api.get<AiUsageResponse>('/ai/usage'),
  });

  const data = usage.data;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">AI 用量</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            每次模型呼叫都會留下紀錄，包含失敗與被限流的次數。
          </p>
        </div>
        <Link href="/ai/jobs">
          <Button variant="secondary">任務列表</Button>
        </Link>
      </div>

      {data && data.totalCalls === 0 && (
        <EmptyState title="還沒有任何 AI 呼叫紀錄" description="對題目啟動分析後就會出現在這裡。" />
      )}

      {data && data.totalCalls > 0 && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="總呼叫次數" value={String(data.totalCalls)} />
            <Stat
              label="成功率"
              value={`${Math.round((data.successCalls / data.totalCalls) * 100)}%`}
              hint={`失敗 ${data.failedCalls} 次`}
            />
            <Stat
              label="平均延遲"
              value={data.avgLatencyMs === null ? '—' : `${(data.avgLatencyMs / 1000).toFixed(1)} 秒`}
              hint={data.p95LatencyMs === null ? undefined : `P95 ${(data.p95LatencyMs / 1000).toFixed(1)} 秒`}
            />
            <Stat
              label="Token 用量"
              value={`${(data.totalInputTokens + data.totalOutputTokens).toLocaleString()}`}
              hint={`輸入 ${data.totalInputTokens.toLocaleString()}／輸出 ${data.totalOutputTokens.toLocaleString()}`}
            />
          </div>

          <div className="space-y-3">
            <h2 className="font-medium">各階段</h2>
            {data.byOperation.map((row) => (
              <Card key={row.operation} className="p-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{OPERATION_LABEL[row.operation] ?? row.operation}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {row.calls} 次
                    {row.successRate !== null && `．成功率 ${row.successRate}%`}
                    {row.avgLatencyMs !== null && `．平均 ${(row.avgLatencyMs / 1000).toFixed(1)} 秒`}
                    ．{row.totalTokens.toLocaleString()} tokens
                  </span>
                </div>
              </Card>
            ))}
          </div>

          <div className="space-y-3">
            <h2 className="font-medium">結果分布</h2>
            <Card className="space-y-2 p-4 text-sm">
              {data.byStatus.map((row) => (
                <div key={row.status} className="flex items-center justify-between">
                  <span>{STATUS_LABEL[row.status] ?? row.status}</span>
                  <span className="tabular-nums text-muted-foreground">{row.count}</span>
                </div>
              ))}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}
