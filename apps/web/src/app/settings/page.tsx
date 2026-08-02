'use client';

import type {
  MaintenanceCleanupResult,
  MaintenancePreview,
  PromptVersionResponse,
  QuizDefaults,
  SettingsResponse,
} from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { AppShell } from '@/components/app-shell';
import { Button, Card, ErrorBanner, Field } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';

export default function SettingsPage() {
  return (
    <AppShell>
      <SettingsView />
    </AppShell>
  );
}

const MODE_LABEL: Record<string, string> = {
  practice: '練習',
  mistake_review: '錯題複習',
  knowledge_focus: '知識點專攻',
  exam: '模擬考',
};

const OPERATION_LABEL: Record<string, string> = {
  research_plan: '① 研究規劃',
  evidence_synthesis: '② 證據整理',
  final_explanation: '③ 最終解析',
  aggregate_analysis: '多題整合分析',
};

function SettingsView() {
  const qc = useQueryClient();

  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<SettingsResponse>('/settings'),
  });

  const promptVersions = useQuery({
    queryKey: ['prompt-versions'],
    queryFn: () => api.get<PromptVersionResponse[]>('/ai/prompt-versions'),
  });

  const save = useMutation({
    mutationFn: (quizDefaults: Partial<QuizDefaults>) =>
      api.patch<SettingsResponse>('/settings', { quizDefaults }),
    onSuccess: (updated) => qc.setQueryData(['settings'], updated),
  });

  const data = settings.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">系統設定</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          作答預設值可以修改；系統資訊為唯讀。金鑰與連線字串只顯示「是否已設定」，永遠不會顯示內容。
        </p>
      </div>

      {save.error instanceof ApiRequestError && (
        <ErrorBanner message={`儲存失敗：${save.error.message}`} />
      )}

      {data && <QuizDefaultsForm defaults={data.quizDefaults} onSave={(v) => save.mutate(v)} saving={save.isPending} />}
      {data && <SystemInfoCard system={data.system} />}
      {promptVersions.data && <PromptVersionsCard versions={promptVersions.data} />}
      <MaintenanceCard />
    </div>
  );
}

function QuizDefaultsForm({
  defaults,
  onSave,
  saving,
}: {
  defaults: QuizDefaults;
  onSave: (value: Partial<QuizDefaults>) => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<QuizDefaults>(defaults);
  const patch = (value: Partial<QuizDefaults>) => setForm((prev) => ({ ...prev, ...value }));

  return (
    <Card>
      <h2 className="text-lg font-semibold">作答預設值</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        建立新的作答場次時的預設選項。每次出題仍可以個別調整。
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="預設模式">
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={form.mode}
            onChange={(e) => patch({ mode: e.target.value as QuizDefaults['mode'] })}
          >
            {Object.entries(MODE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="對答案時機">
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={form.revealMode}
            onChange={(e) => patch({ revealMode: e.target.value as QuizDefaults['revealMode'] })}
          >
            <option value="immediate">作答後立即顯示</option>
            <option value="after_submit">交卷後才顯示</option>
          </select>
        </Field>

        <Field label="出題順序">
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={form.orderStrategy}
            onChange={(e) =>
              patch({ orderStrategy: e.target.value as QuizDefaults['orderStrategy'] })
            }
          >
            <option value="sequential">依題號</option>
            <option value="random">隨機</option>
          </select>
        </Field>

        <Field label="每次題數" hint="留空代表不限題數">
          <input
            type="number"
            min={1}
            max={500}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={form.questionLimit ?? ''}
            onChange={(e) =>
              patch({ questionLimit: e.target.value === '' ? null : Number(e.target.value) })
            }
          />
        </Field>
      </div>

      <div className="mt-4 space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.shuffleOptions}
            onChange={(e) => patch({ shuffleOptions: e.target.checked })}
          />
          打亂選項順序（判分一律比對真實答案，不受顯示順序影響）
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.allowAnswerChange}
            onChange={(e) => patch({ allowAnswerChange: e.target.checked })}
          />
          允許交卷前修改答案
        </label>
      </div>

      <div className="mt-4">
        <Button onClick={() => onSave(form)} disabled={saving}>
          {saving ? '儲存中…' : '儲存'}
        </Button>
      </div>
    </Card>
  );
}

function SystemInfoCard({ system }: { system: SettingsResponse['system'] }) {
  return (
    <Card>
      <h2 className="text-lg font-semibold">系統資訊</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        以下皆為唯讀，由環境變數決定。要修改請編輯 <code>.env</code> 後重啟。
      </p>

      <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Row label="AI provider" value={system.aiProvider} />
        <Row label="搜尋 provider" value={system.searchProvider} />
        <Row label="模型" value={system.model} />
        <Row label="證據保留天數" value={`${system.evidenceStaleAfterDays} 天`} />
        <Row label="推理強度（規劃）" value={system.reasoningEffort.plan} />
        <Row label="推理強度（證據）" value={system.reasoningEffort.evidence} />
        <Row label="推理強度（解析）" value={system.reasoningEffort.final} />
        <Row label="推理強度（多題診斷）" value={system.reasoningEffort.aggregate} />
      </dl>

      <h3 className="mt-6 text-sm font-medium">機密變數</h3>
      <p className="mt-1 text-xs text-muted-foreground">只顯示是否已設定，永遠不顯示內容。</p>
      <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
        {Object.entries(system.secretsConfigured).map(([key, configured]) => (
          <li key={key} className="flex items-center gap-2">
            <span className={configured ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
              {configured ? '✔' : '✘'}
            </span>
            <code className="text-xs">{key}</code>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PromptVersionsCard({ versions }: { versions: PromptVersionResponse[] }) {
  return (
    <Card>
      <h2 className="text-lg font-semibold">Prompt 版本</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        版本由程式碼決定：prompt 內容進版控，改內容就要改版號。這裡不提供切換——
        版本是 AI 快取鍵的一部分，切換等於讓既有解析全部失效並需要重新分析。
      </p>
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="pb-2 font-medium">階段</th>
            <th className="pb-2 font-medium">版本</th>
            <th className="pb-2 font-medium">啟用中</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((version) => (
            <tr key={version.id} className="border-b last:border-0">
              <td className="py-2">{OPERATION_LABEL[version.operation] ?? version.operation}</td>
              <td className="py-2 tabular-nums">{version.version}</td>
              <td className="py-2">{version.isActive ? '✔' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function MaintenanceCard() {
  const [result, setResult] = useState<MaintenanceCleanupResult | null>(null);

  const preview = useQuery({
    queryKey: ['maintenance-preview'],
    queryFn: () => api.get<MaintenancePreview>('/maintenance/preview'),
  });

  const cleanup = useMutation({
    mutationFn: (recomputeMistakes: boolean) =>
      api.post<MaintenanceCleanupResult>('/maintenance/cleanup', { recomputeMistakes }),
    onSuccess: (data) => {
      setResult(data);
      void preview.refetch();
    },
  });

  return (
    <Card>
      <h2 className="text-lg font-semibold">維護作業</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        手動觸發，不會自動排程。只清除「已過期且沒有任何解析引用」的網頁快取——
        被引用的來源即使過期也會保留，否則既有解析的引用會指向不存在的東西。
        證據集合本身一律不刪：它是既有解析的依據。
      </p>

      {preview.data && (
        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
          <Metric label="過期網頁快取" value={preview.data.expiredWebDocuments} />
          <Metric label="其中可安全清除" value={preview.data.orphanWebDocuments} />
          <Metric label="過期證據集合（保留）" value={preview.data.expiredEvidenceSets} />
        </dl>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => cleanup.mutate(false)} disabled={cleanup.isPending}>
          清除過期快取
        </Button>
        <Button variant="secondary" onClick={() => cleanup.mutate(true)} disabled={cleanup.isPending}>
          清除並重算錯題統計
        </Button>
      </div>

      {cleanup.error instanceof ApiRequestError && (
        <div className="mt-3">
          <ErrorBanner message={`維護作業失敗：${cleanup.error.message}`} />
        </div>
      )}

      {result && (
        <p className="mt-3 text-sm text-muted-foreground">
          已清除 {result.deletedWebDocuments} 筆網頁快取
          {result.recomputedMistakeRecords > 0 &&
            `，重算 ${result.recomputedMistakeRecords} 題的錯題紀錄`}
          。
        </p>
      )}
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
