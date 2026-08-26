'use client';

import type {
  ErrorTypeResponse,
  KnowledgeTagResponse,
  PaginationMeta,
  SkillTagResponse,
  SubjectResponse,
  TagAliasResponse,
} from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { AppShell } from '@/components/app-shell';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, selectClass } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export default function TagsPage() {
  return (
    <AppShell>
      <TagsView />
    </AppShell>
  );
}

type Tab = 'knowledge' | 'skill' | 'error' | 'alias';

const TABS: { key: Tab; label: string }[] = [
  { key: 'knowledge', label: '知識點' },
  { key: 'skill', label: '能力類型' },
  { key: 'error', label: '錯誤類型' },
  { key: 'alias', label: '別名' },
];

function TagsView() {
  const [tab, setTab] = useState<Tab>('knowledge');

  const pending = useQuery({
    queryKey: ['tag-suggestions', 'pending-count'],
    queryFn: () =>
      api.get<{ items: unknown[]; pagination: PaginationMeta }>(
        '/tag-suggestions?status=pending&pageSize=1',
      ),
  });
  const pendingCount = pending.data?.pagination.total ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">標籤管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            標籤是受控詞彙：AI 只能從這裡挑選，不能自己造新的。
          </p>
        </div>
        <Link href="/tags/suggestions" className="shrink-0">
          <Button variant={pendingCount > 0 ? 'primary' : 'secondary'} className="w-full sm:w-auto">
            待審建議{pendingCount > 0 ? ` ${pendingCount}` : ''}
          </Button>
        </Link>
      </div>

      {/*
        分頁列讓它自己橫向捲，而不是換行。
        分頁的底線是一條連續的視覺基準，折成兩行會出現兩條線，看起來像兩組不同的東西。
      */}
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex min-w-max gap-1 border-b">
          {TABS.map((item) => (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              className={cn(
                '-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm transition',
                tab === item.key
                  ? 'border-primary font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'knowledge' && <KnowledgeTagsPanel />}
      {tab === 'skill' && <SkillTagsPanel />}
      {tab === 'error' && <ErrorTypesPanel />}
      {tab === 'alias' && <AliasesPanel />}
    </div>
  );
}

// ------------------------------------------------------------------ 知識點

function KnowledgeTagsPanel() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [mergeSource, setMergeSource] = useState<KnowledgeTagResponse | null>(null);

  const subjects = useQuery({
    queryKey: ['subjects'],
    queryFn: () => api.get<SubjectResponse[]>('/subjects'),
  });

  const tags = useQuery({
    queryKey: ['knowledge-tags'],
    queryFn: () =>
      api.get<{ items: KnowledgeTagResponse[]; pagination: PaginationMeta }>(
        '/knowledge-tags?pageSize=100',
      ),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['knowledge-tags'] });
    void qc.invalidateQueries({ queryKey: ['tag-aliases'] });
  };

  const create = useMutation({
    mutationFn: () =>
      api.post('/knowledge-tags', { name, subjectId: subjectId || null }),
    onSuccess: () => {
      setName('');
      invalidate();
    },
  });

  const deprecate = useMutation({
    mutationFn: (id: string) => api.post(`/knowledge-tags/${id}/deprecate`),
    onSuccess: invalidate,
  });

  const activate = useMutation({
    mutationFn: (id: string) => api.post(`/knowledge-tags/${id}/activate`),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/knowledge-tags/${id}`),
    onSuccess: invalidate,
  });

  const merge = useMutation({
    mutationFn: (targetTagId: string) =>
      api.post(`/knowledge-tags/${mergeSource!.id}/merge`, { targetTagId }),
    onSuccess: () => {
      setMergeSource(null);
      invalidate();
    },
  });

  const error = [create.error, deprecate.error, remove.error, merge.error, activate.error].find(
    (e): e is ApiRequestError => e instanceof ApiRequestError,
  );

  const items = tags.data?.items ?? [];

  return (
    <div className="space-y-5">
      <Card className="space-y-4">
        <h2 className="font-medium">新增知識點</h2>
        {/*
          `min-w-[220px]` 加 flex-wrap 在手機是會出事的組合：
          360px 的螢幕扣掉卡片內距只剩約 328px，兩個欄位排不下就各自佔一列，
          但 220px 的下限又讓它們無法收窄，右邊會被撐出去。
          手機直接改成單欄堆疊，最小寬度只在桌機生效。
        */}
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="sm:min-w-[220px] sm:flex-1">
            <Field label="名稱">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：行政處分"
              />
            </Field>
          </div>
          <div className="sm:min-w-[180px]">
            <Field label="限定科目" hint="不選代表跨科目通用">
              <select
                className={selectClass}
                value={subjectId}
                onChange={(e) => setSubjectId(e.target.value)}
              >
                <option value="">跨科目通用</option>
                {subjects.data?.map((subject) => (
                  <option key={subject.id} value={subject.id}>
                    {subject.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Button
            className="w-full sm:w-auto"
            onClick={() => create.mutate()}
            disabled={!name.trim() || create.isPending}
          >
            新增
          </Button>
        </div>
      </Card>

      {error && <ErrorBanner message={error.message} details={error.details} />}

      {mergeSource && (
        <Card className="space-y-3 border-primary">
          <h2 className="font-medium">把「{mergeSource.name}」合併到…</h2>
          <p className="text-sm text-muted-foreground">
            這 {mergeSource.usageCount} 題的標註會全部轉移到目標，
            「{mergeSource.name}」會成為目標的別名。資料不會消失。
          </p>
          <div className="flex flex-wrap gap-2">
            {items
              .filter((tag) => tag.id !== mergeSource.id && tag.status !== 'merged')
              .map((tag) => (
                <Button
                  key={tag.id}
                  variant="secondary"
                  disabled={merge.isPending}
                  onClick={() => merge.mutate(tag.id)}
                >
                  {tag.name}
                </Button>
              ))}
          </div>
          <Button variant="ghost" onClick={() => setMergeSource(null)}>
            取消
          </Button>
        </Card>
      )}

      {items.length === 0 && <EmptyState title="還沒有任何知識點" />}

      <div className="space-y-2">
        {items.map((tag) => (
          <Card key={tag.id} className="flex flex-wrap items-center gap-3 p-4">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {tag.name}
                {tag.status === 'deprecated' && (
                  <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    已停用
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {tag.subjectName ?? '跨科目'} · 已用於 {tag.usageCount} 題
                {tag.aliases.length > 0 && ` · 別名：${tag.aliases.join('、')}`}
              </p>
            </div>
            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
              <Button variant="secondary" onClick={() => setMergeSource(tag)}>
                合併
              </Button>
              {tag.status === 'active' ? (
                <Button variant="ghost" onClick={() => deprecate.mutate(tag.id)}>
                  停用
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => activate.mutate(tag.id)}>
                  啟用
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={tag.usageCount > 0}
                title={tag.usageCount > 0 ? '已被使用，請改用停用或合併' : undefined}
                onClick={() => remove.mutate(tag.id)}
              >
                刪除
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// -------------------------------------------------------------- 能力類型

function SkillTagsPanel() {
  const qc = useQueryClient();
  const [name, setName] = useState('');

  const tags = useQuery({
    queryKey: ['skill-tags', 'all'],
    queryFn: () => api.get<SkillTagResponse[]>('/skill-tags?includeDeprecated=true'),
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['skill-tags'] });

  const create = useMutation({
    mutationFn: () => api.post('/skill-tags', { name }),
    onSuccess: () => {
      setName('');
      invalidate();
    },
  });

  const toggle = useMutation({
    mutationFn: (tag: SkillTagResponse) =>
      api.patch(`/skill-tags/${tag.id}`, {
        status: tag.status === 'active' ? 'deprecated' : 'active',
      }),
    onSuccess: invalidate,
  });

  const error = [create.error, toggle.error].find((e): e is ApiRequestError => e instanceof ApiRequestError);

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        能力類型描述「這題考的是哪一種能力」。系統預設 6 種，可自行新增。
      </p>

      <Card className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="sm:min-w-[220px] sm:flex-1">
          <Field label="新增能力類型">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：計算能力" />
          </Field>
        </div>
        <Button
          className="w-full sm:w-auto"
          onClick={() => create.mutate()}
          disabled={!name.trim() || create.isPending}
        >
          新增
        </Button>
      </Card>

      {error && <ErrorBanner message={error.message} details={error.details} />}

      <div className="space-y-2">
        {tags.data?.map((tag) => (
          <Card key={tag.id} className="flex flex-wrap items-center gap-3 p-4">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {tag.name}
                {tag.status !== 'active' && (
                  <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    已停用
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {tag.description} · 已用於 {tag.usageCount} 題
              </p>
            </div>
            <Button variant="ghost" onClick={() => toggle.mutate(tag)}>
              {tag.status === 'active' ? '停用' : '啟用'}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}

// -------------------------------------------------------------- 錯誤類型

function ErrorTypesPanel() {
  const types = useQuery({
    queryKey: ['error-types', 'all'],
    queryFn: () => api.get<ErrorTypeResponse[]>('/error-types?includeDeprecated=true'),
  });

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        錯誤類型描述「這題為什麼錯」。這是一組固定的診斷詞彙，不接受新增 ——
        自由新增會讓錯因統計失去可比較性。
      </p>

      <div className="space-y-2">
        {types.data?.map((type) => (
          <Card key={type.id} className="flex items-center gap-3 p-4">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {type.name}
                {type.isFallback && (
                  <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-xs">
                    保留項目
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {type.description} · 已標記 {type.usageCount} 題
              </p>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 別名

function AliasesPanel() {
  const qc = useQueryClient();
  const [alias, setAlias] = useState('');
  const [canonicalTagId, setCanonicalTagId] = useState('');

  const aliases = useQuery({
    queryKey: ['tag-aliases'],
    queryFn: () => api.get<TagAliasResponse[]>('/tag-aliases?tagKind=knowledge'),
  });

  const tags = useQuery({
    queryKey: ['knowledge-tags'],
    queryFn: () =>
      api.get<{ items: KnowledgeTagResponse[]; pagination: PaginationMeta }>(
        '/knowledge-tags?pageSize=100',
      ),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['tag-aliases'] });
    void qc.invalidateQueries({ queryKey: ['knowledge-tags'] });
  };

  const create = useMutation({
    mutationFn: () => api.post('/tag-aliases', { tagKind: 'knowledge', alias, canonicalTagId }),
    onSuccess: () => {
      setAlias('');
      invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/tag-aliases/${id}`),
    onSuccess: invalidate,
  });

  const error = [create.error, remove.error].find(
    (e): e is ApiRequestError => e instanceof ApiRequestError,
  );

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        別名把不同寫法映射到同一個標籤。大小寫、全形半形與空白差異已自動處理，
        這裡只需要登錄真正不同的寫法（例如錯字或簡稱）。
      </p>

      <Card className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="sm:min-w-[200px] sm:flex-1">
          <Field label="別名">
            <Input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="例如：行政處份" />
          </Field>
        </div>
        <div className="sm:min-w-[200px] sm:flex-1">
          <Field label="對應到">
            <select
              className={selectClass}
              value={canonicalTagId}
              onChange={(e) => setCanonicalTagId(e.target.value)}
            >
              <option value="">請選擇知識點</option>
              {tags.data?.items
                .filter((tag) => tag.status !== 'merged')
                .map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <Button
          className="w-full sm:w-auto"
          onClick={() => create.mutate()}
          disabled={!alias.trim() || !canonicalTagId || create.isPending}
        >
          新增
        </Button>
      </Card>

      {error && <ErrorBanner message={error.message} details={error.details} />}

      {aliases.data?.length === 0 && <EmptyState title="還沒有任何別名" />}

      <div className="space-y-2">
        {aliases.data?.map((item) => (
          <Card key={item.id} className="flex items-center gap-3 p-4 text-sm">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{item.alias}</span>
              <span className="text-muted-foreground"> → {item.canonicalTagName}</span>
            </span>
            <Button variant="ghost" className="shrink-0" onClick={() => remove.mutate(item.id)}>
              刪除
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
