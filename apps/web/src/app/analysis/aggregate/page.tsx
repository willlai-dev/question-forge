'use client';

import {
  AI_PROGRESS_STEPS,
  type AggregateAnalysisResponse,
  type AggregateStatsResponse,
  type AiJobResponse,
} from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { AppShell } from '@/components/app-shell';
import { Button, Card, EmptyState, ErrorBanner } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';

export default function AggregateAnalysisPage() {
  return (
    <AppShell>
      <AggregateAnalysisView />
    </AppShell>
  );
}

const SEVERITY_LABEL: Record<string, string> = {
  critical: '嚴重',
  high: '偏弱',
  moderate: '需留意',
};

const SEVERITY_CLASS: Record<string, string> = {
  critical: 'bg-destructive/10 text-destructive',
  high: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  moderate: 'bg-muted text-muted-foreground',
};

function AggregateAnalysisView() {
  const qc = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);

  const latest = useQuery({
    queryKey: ['aggregate-analysis', 'latest'],
    queryFn: () => api.get<AggregateAnalysisResponse | null>('/ai/aggregate-analyses/latest'),
  });

  // 統計本身不需要 AI，因此不必等分析跑完就能看到目前的數字。
  const stats = useQuery({
    queryKey: ['aggregate-stats'],
    queryFn: () => api.get<AggregateStatsResponse>('/stats/aggregate'),
  });

  const job = useQuery({
    queryKey: ['ai-job', jobId],
    queryFn: () => api.get<AiJobResponse>(`/ai/jobs/${jobId}`),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'completed' || status === 'failed' || status === 'cancelled' ? false : 1500;
    },
  });

  const start = useMutation({
    mutationFn: () =>
      api.post<AiJobResponse>('/ai/aggregate-analyses', { scopeType: 'all', force: true }),
    onSuccess: (created) => setJobId(created.id),
  });

  // 在 effect 裡重新取結果，而不是在 render 期間 invalidate。
  useEffect(() => {
    if (job.data?.status === 'completed') {
      void qc.invalidateQueries({ queryKey: ['aggregate-analysis', 'latest'] });
      void qc.invalidateQueries({ queryKey: ['aggregate-stats'] });
    }
  }, [job.data?.status, qc]);

  const running =
    jobId !== null &&
    job.data !== undefined &&
    job.data.status !== 'completed' &&
    job.data.status !== 'failed' &&
    job.data.status !== 'cancelled';

  const analysis = latest.data ?? null;
  const overall = stats.data?.stats.overall;
  const noData = overall !== undefined && overall.totalAnswered === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">學習診斷</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            先由資料庫算出各科目、章節、知識點的正確率與趨勢，再挑出最多 15
            題代表性錯題交給 AI，找出跨知識點的共同錯誤模式。統計本身不需要 AI，隨時都是最新的。
          </p>
        </div>
        <Button
          className="w-full shrink-0 sm:w-auto"
          onClick={() => start.mutate()}
          disabled={running || start.isPending || noData}
        >
          {running ? '分析中…' : analysis ? '重新分析' : '開始分析'}
        </Button>
      </div>

      {start.error instanceof ApiRequestError && (
        <ErrorBanner message={`無法啟動分析：${start.error.message}`} />
      )}
      {job.data?.status === 'failed' && (
        <ErrorBanner message={`分析失敗：${job.data.errorMessage ?? '未知錯誤'}`} />
      )}

      {running && job.data && (
        <Card>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span>{AI_PROGRESS_STEPS[job.data.progressStep].label}</span>
              <span className="tabular-nums text-muted-foreground">{job.data.progressPct}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all duration-500"
                style={{ width: `${job.data.progressPct}%` }}
              />
            </div>
          </div>
        </Card>
      )}

      {noData && (
        <EmptyState
          title="還沒有可以診斷的作答"
          description="先去作答，累積一些紀錄之後再回來。爭議中與已排除的題目不會計入診斷。"
        />
      )}

      {stats.data && !noData && <StatsSummary data={stats.data} />}

      {analysis === null && !noData && !running && (
        <EmptyState
          title="尚未產生整合分析"
          description="上方統計已經可以看，按「開始分析」讓 AI 找出跨知識點的共同錯誤模式。"
        />
      )}

      {analysis && <AnalysisContent analysis={analysis} />}
    </div>
  );
}

function StatsSummary({ data }: { data: AggregateStatsResponse }) {
  const { stats, representativeQuestions } = data;
  const { overall, knowledgeTagCoverage: coverage } = stats;

  return (
    <Card>
      <h2 className="text-lg font-semibold">統計摘要</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {new Date(stats.period.from).toLocaleDateString('zh-TW')} ～{' '}
        {new Date(stats.period.to).toLocaleDateString('zh-TW')}
        ；已排除爭議中、已排除與已刪除題目的作答
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label="作答題數" value={String(overall.totalAnswered)} />
        <Metric
          label="正確率"
          value={overall.accuracy === null ? '—' : `${overall.accuracy}%`}
        />
        <Metric
          label="平均作答時間"
          value={overall.avgResponseTimeMs === null ? '—' : `${overall.avgResponseTimeMs} ms`}
          hint={
            overall.responseTimeSamples < overall.totalAnswered
              ? `僅 ${overall.responseTimeSamples}/${overall.totalAnswered} 題有記錄`
              : undefined
          }
        />
        <Metric label="代表性錯題" value={String(representativeQuestions.length)} />
      </dl>

      {stats.byKnowledgeTag.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium">各知識點</h3>
          {coverage.taggedAnswered < coverage.totalAnswered && (
            <p className="mt-1 text-xs text-muted-foreground">
              只有 {coverage.taggedAnswered}/{coverage.totalAnswered}{' '}
              題的作答有標記知識點，以下結論僅涵蓋這部分資料。
            </p>
          )}
          <ul className="mt-2 space-y-1 text-sm">
            {stats.byKnowledgeTag.slice(0, 10).map((tag) => (
              <li key={tag.id} className="flex items-center justify-between gap-3 sm:gap-4">
                <span className="min-w-0 truncate">{tag.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {tag.accuracy === null ? '—' : `${tag.accuracy}%`}
                  <span className="ml-2">
                    {tag.trend === null ? (
                      <span className="text-muted-foreground">資料不足</span>
                    ) : tag.trend > 0 ? (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        ▲ {tag.trend}
                      </span>
                    ) : tag.trend < 0 ? (
                      <span className="text-destructive">▼ {Math.abs(tag.trend)}</span>
                    ) : (
                      <span className="text-muted-foreground">持平</span>
                    )}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {stats.consecutiveWrongStreaks.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium">目前仍連續答錯</h3>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {stats.consecutiveWrongStreaks.map((streak) => (
              <li key={streak.knowledgeTagId}>
                {streak.knowledgeTagName}：連續 {streak.streak} 題，尚未答對
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold tabular-nums">{value}</dd>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function AnalysisContent({ analysis }: { analysis: AggregateAnalysisResponse }) {
  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">整體診斷</h2>
          <span className="text-xs text-muted-foreground">
            {new Date(analysis.createdAt).toLocaleString('zh-TW')}／{analysis.model}
            {analysis.confidence !== null && `／信心 ${Math.round(analysis.confidence * 100)}%`}
          </span>
        </div>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">
          {analysis.improvement.summary}
        </p>
        {analysis.improvement.improvedAreas.length > 0 && (
          <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">
            已改善：{analysis.improvement.improvedAreas.join('、')}
          </p>
        )}
        {analysis.improvement.stagnantAreas.length > 0 && (
          <p className="mt-1 text-sm text-muted-foreground">
            仍待加強：{analysis.improvement.stagnantAreas.join('、')}
          </p>
        )}
      </Card>

      {analysis.weakestKnowledgeTags.length > 0 && (
        <Card>
          <h2 className="text-lg font-semibold">最薄弱的知識點</h2>
          <ul className="mt-3 space-y-3">
            {analysis.weakestKnowledgeTags.map((tag) => (
              <li key={tag.tagName} className="flex gap-2 sm:gap-3">
                <span
                  className={`h-fit shrink-0 rounded px-2 py-0.5 text-xs ${SEVERITY_CLASS[tag.severity] ?? ''}`}
                >
                  {SEVERITY_LABEL[tag.severity] ?? tag.severity}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {tag.tagName}
                    <span className="ml-2 tabular-nums text-muted-foreground">{tag.accuracy}%</span>
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{tag.evidence}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {analysis.errorPatterns.length > 0 && (
        <Card>
          <h2 className="text-lg font-semibold">共同錯誤模式</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            跨知識點反覆出現的錯法，通常代表讀法或思考習慣的問題，而非個別知識缺口。
          </p>
          <ul className="mt-3 space-y-4">
            {analysis.errorPatterns.map((pattern, index) => (
              <li key={index}>
                <p className="text-sm font-medium">{pattern.pattern}</p>
                <p className="mt-1 text-sm text-muted-foreground">{pattern.explanation}</p>
                {pattern.relatedKnowledgeTags.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    涉及：{pattern.relatedKnowledgeTags.join('、')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {analysis.reviewPriority.length > 0 && (
        <Card>
          <h2 className="text-lg font-semibold">建議複習順序</h2>
          <ol className="mt-3 space-y-2">
            {analysis.reviewPriority.map((item) => (
              <li key={item.rank} className="flex gap-2 text-sm sm:gap-3">
                <span className="w-6 shrink-0 tabular-nums text-muted-foreground">
                  {item.rank}.
                </span>
                <div className="min-w-0">
                  <p className="font-medium">{item.target}</p>
                  <p className="text-muted-foreground">{item.reason}</p>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {analysis.recommendedPractice.length > 0 && (
        <Card>
          <h2 className="text-lg font-semibold">建議重練</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {analysis.recommendedPractice.map((item) => (
              <li key={`${item.kind}-${item.refId}`}>
                {item.kind === 'question' ? (
                  <Link href={`/mistakes/${item.refId}`} className="font-medium hover:underline">
                    {item.label}
                  </Link>
                ) : (
                  <span className="font-medium">{item.label}</span>
                )}
                <span className="ml-2 text-muted-foreground">{item.reason}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {analysis.learningSuggestions.length > 0 && (
        <Card>
          <h2 className="text-lg font-semibold">具體學習建議</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
            {analysis.learningSuggestions.map((suggestion, index) => (
              <li key={index}>{suggestion}</li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <h2 className="text-sm font-semibold">分析依據</h2>
        <p className="mt-2 text-sm text-muted-foreground">{analysis.analysisBasis}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          這份結論連同當時的統計快照一起保存，因此可以回頭核對每個數字的來源。
        </p>
      </Card>
    </div>
  );
}
