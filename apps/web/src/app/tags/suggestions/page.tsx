'use client';

import type {
  KnowledgeTagResponse,
  PaginationMeta,
  TagSuggestionResponse,
} from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';

import { AppShell } from '@/components/app-shell';
import { Button, Card, EmptyState, ErrorBanner, Input } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export default function TagSuggestionsPage() {
  return (
    <AppShell>
      <TagSuggestionsView />
    </AppShell>
  );
}

const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  pending: { label: '待審核', className: 'bg-amber-100 text-amber-800' },
  approved: { label: '已核准', className: 'bg-emerald-100 text-emerald-800' },
  merged: { label: '已併入', className: 'bg-secondary text-secondary-foreground' },
  rejected: { label: '已退回', className: 'bg-muted text-muted-foreground' },
};

const KIND_LABEL: Record<string, string> = {
  knowledge: '知識點',
  skill: '能力類型',
  error_type: '錯誤類型',
};

function TagSuggestionsView() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('pending');
  const [mergeTarget, setMergeTarget] = useState<TagSuggestionResponse | null>(null);
  const [newName, setNewName] = useState<Record<string, string>>({});

  const suggestions = useQuery({
    queryKey: ['tag-suggestions', status],
    queryFn: () =>
      api.get<{ items: TagSuggestionResponse[]; pagination: PaginationMeta }>(
        `/tag-suggestions?pageSize=50${status ? `&status=${status}` : ''}`,
      ),
  });

  const tags = useQuery({
    queryKey: ['knowledge-tags'],
    queryFn: () =>
      api.get<{ items: KnowledgeTagResponse[]; pagination: PaginationMeta }>(
        '/knowledge-tags?pageSize=100',
      ),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['tag-suggestions'] });
    void qc.invalidateQueries({ queryKey: ['knowledge-tags'] });
  };

  const approve = useMutation({
    mutationFn: (item: TagSuggestionResponse) =>
      api.post(`/tag-suggestions/${item.id}/approve`, {
        ...(newName[item.id]?.trim() ? { name: newName[item.id]!.trim() } : {}),
      }),
    onSuccess: invalidate,
  });

  const merge = useMutation({
    mutationFn: (targetTagId: string) =>
      api.post(`/tag-suggestions/${mergeTarget!.id}/merge`, { targetTagId }),
    onSuccess: () => {
      setMergeTarget(null);
      invalidate();
    },
  });

  const reject = useMutation({
    mutationFn: (id: string) => api.post(`/tag-suggestions/${id}/reject`, {}),
    onSuccess: invalidate,
  });

  const error = [approve.error, merge.error, reject.error].find(
    (e): e is ApiRequestError => e instanceof ApiRequestError,
  );

  const items = suggestions.data?.items ?? [];

  return (
    <div className="space-y-6">
      <div>
        <Link href="/tags" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← 回標籤管理
        </Link>
        <h1 className="mt-3 text-xl font-bold tracking-tight sm:text-2xl">標籤建議審核</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          AI 找不到合適的既有標籤時只能提交建議到這裡，不能自行建立正式標籤。
        </p>
      </div>

      {/* 五個狀態分頁鈕在手機排不進一列，允許換行。 */}
      <div className="flex flex-wrap gap-2">
        {[
          { value: 'pending', label: '待審核' },
          { value: 'approved', label: '已核准' },
          { value: 'merged', label: '已併入' },
          { value: 'rejected', label: '已退回' },
          { value: '', label: '全部' },
        ].map((option) => (
          <Button
            key={option.value}
            variant={status === option.value ? 'primary' : 'secondary'}
            onClick={() => setStatus(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>

      {error && <ErrorBanner message={error.message} details={error.details} />}

      {mergeTarget && (
        <Card className="space-y-3 border-primary">
          <h2 className="font-medium">把「{mergeTarget.suggestedName}」併入…</h2>
          <p className="text-sm text-muted-foreground">
            會自動建立別名，下次再出現這個名稱就直接對應，不會再變成建議。
          </p>
          <div className="flex flex-wrap gap-2">
            {tags.data?.items
              .filter((tag) => tag.status !== 'merged')
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
          <Button variant="ghost" onClick={() => setMergeTarget(null)}>
            取消
          </Button>
        </Card>
      )}

      {items.length === 0 && (
        <EmptyState
          title="沒有符合條件的建議"
          description="Phase 4 接上 AI 分析後，未知的標籤會自動出現在這裡等待審核。"
        />
      )}

      <div className="space-y-3">
        {items.map((item) => {
          const badge = STATUS_LABEL[item.status]!;
          return (
            <Card key={item.id} className="space-y-3">
              <div className="flex items-start justify-between gap-3 sm:gap-4">
                <div className="min-w-0">
                  <p className="font-medium">{item.suggestedName}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {KIND_LABEL[item.tagKind] ?? item.tagKind} ·{' '}
                    {item.source === 'ai' ? 'AI 建議' : '手動提交'}
                    {item.occurrenceCount > 1 && ` · 被建議 ${item.occurrenceCount} 次`}
                    {item.resolvedTagName && ` · 對應到「${item.resolvedTagName}」`}
                  </p>
                </div>
                <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-xs', badge.className)}>
                  {badge.label}
                </span>
              </div>

              {item.rationale && (
                <p className="rounded-md bg-muted/40 p-3 text-sm leading-relaxed">{item.rationale}</p>
              )}

              {item.contextQuestionStem && (
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  來自題目：{item.contextQuestionStem}
                </p>
              )}

              {item.status === 'pending' && (
                <div className="flex flex-wrap items-center gap-2">
                  {/*
                    固定 220px 上限在手機會留下右側一大塊空白，
                    改成「窄螢幕佔滿整列、桌機才收斂到 220px」。
                  */}
                  <Input
                    className="w-full sm:max-w-[220px]"
                    placeholder={`核准後的名稱（預設 ${item.suggestedName}）`}
                    value={newName[item.id] ?? ''}
                    onChange={(e) => setNewName((prev) => ({ ...prev, [item.id]: e.target.value }))}
                  />
                  <Button
                    disabled={approve.isPending || item.tagKind === 'error_type'}
                    title={item.tagKind === 'error_type' ? '錯誤類型不接受新增，請改為併入' : undefined}
                    onClick={() => approve.mutate(item)}
                  >
                    核准並建立
                  </Button>
                  <Button variant="secondary" onClick={() => setMergeTarget(item)}>
                    併入既有標籤
                  </Button>
                  <Button variant="ghost" onClick={() => reject.mutate(item.id)}>
                    退回
                  </Button>
                </div>
              )}

              {item.reviewNote && (
                <p className="text-xs text-muted-foreground">審核備註：{item.reviewNote}</p>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
