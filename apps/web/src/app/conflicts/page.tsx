'use client';

import type { AnswerConflictResponse, PaginationMeta } from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { AppShell } from '@/components/app-shell';
import { Button, Card, EmptyState, ErrorBanner, Field, Input } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export default function ConflictsPage() {
  return (
    <AppShell>
      <ConflictsView />
    </AppShell>
  );
}

const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  pending: { label: '待裁決', className: 'bg-amber-100 text-amber-800' },
  kept_original: { label: '維持原答案', className: 'bg-secondary text-secondary-foreground' },
  answer_updated: { label: '已修改答案', className: 'bg-emerald-100 text-emerald-800' },
  explanation_updated: { label: '已更新解析', className: 'bg-emerald-100 text-emerald-800' },
  marked_disputed: { label: '維持爭議', className: 'bg-destructive/10 text-destructive' },
  question_excluded: { label: '已排除題目', className: 'bg-muted text-muted-foreground' },
};

function ConflictsView() {
  const qc = useQueryClient();
  const [reviewStatus, setReviewStatus] = useState('pending');
  const [notes, setNotes] = useState<Record<string, string>>({});

  const conflicts = useQuery({
    queryKey: ['conflicts', reviewStatus],
    queryFn: () =>
      api.get<{ items: AnswerConflictResponse[]; pagination: PaginationMeta }>(
        `/answer-conflicts?pageSize=50${reviewStatus ? `&reviewStatus=${reviewStatus}` : ''}`,
      ),
  });

  const resolve = useMutation({
    mutationFn: (args: { id: string; decision: string; correctAnswers?: string[] }) =>
      api.post(`/answer-conflicts/${args.id}/resolve`, {
        decision: args.decision,
        ...(args.correctAnswers ? { correctAnswers: args.correctAnswers } : {}),
        ...(notes[args.id]?.trim() ? { reviewNote: notes[args.id]!.trim() } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['conflicts'] });
      void qc.invalidateQueries({ queryKey: ['questions'] });
    },
  });

  const error = resolve.error instanceof ApiRequestError ? resolve.error : null;
  const items = conflicts.data?.items ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">答案爭議</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          AI 認為題庫答案可能有誤時會建立這裡的紀錄。
          <strong>AI 不會自己改答案</strong>——只有你可以裁決。待裁決期間該題不計入能力診斷。
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {[
          { value: 'pending', label: '待裁決' },
          { value: '', label: '全部' },
        ].map((option) => (
          <Button
            key={option.value}
            variant={reviewStatus === option.value ? 'primary' : 'secondary'}
            onClick={() => setReviewStatus(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>

      {error && <ErrorBanner message={error.message} details={error.details} />}

      {items.length === 0 && (
        <EmptyState
          title="沒有待裁決的爭議"
          description="AI 分析發現題庫答案與外部證據不一致時，會自動出現在這裡。"
        />
      )}

      <div className="space-y-4">
        {items.map((item) => {
          const badge = STATUS_LABEL[item.reviewStatus]!;
          return (
            <Card key={item.id} className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">
                    {item.subjectName} · 第 {item.questionNumber} 題
                  </p>
                  <p className="mt-1 whitespace-pre-wrap leading-relaxed">{item.questionStem}</p>
                </div>
                <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-xs', badge.className)}>
                  {badge.label}
                </span>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border px-3 py-2 text-sm">
                  <p className="text-xs text-muted-foreground">題庫目前的答案</p>
                  <p className="mt-0.5 font-medium">{item.storedAnswers.join('、')}</p>
                </div>
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm">
                  <p className="text-xs text-amber-900">AI 依據外部證據認為的答案</p>
                  <p className="mt-0.5 font-medium">{item.verifiedAnswers.join('、')}</p>
                </div>
              </div>

              <div className="rounded-md bg-muted/40 p-3 text-sm">
                <p className="font-medium">爭議理由</p>
                <p className="mt-1 whitespace-pre-wrap leading-relaxed">{item.conflictReason}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  信心 {Math.round(item.confidence * 100)}%
                </p>
              </div>

              <div className="space-y-1.5">
                {item.options.map((option) => (
                  <div
                    key={option.key}
                    className={cn(
                      'flex items-start gap-3 rounded-md border px-3 py-2 text-sm',
                      option.isCorrect && 'border-emerald-500 bg-emerald-50',
                      item.verifiedAnswers.includes(option.key) &&
                        !option.isCorrect &&
                        'border-amber-400 bg-amber-50',
                    )}
                  >
                    <span className="font-medium">{option.key}</span>
                    <span className="flex-1">{option.text}</span>
                  </div>
                ))}
              </div>

              {item.sources.length > 0 && (
                <div className="space-y-1 text-sm">
                  <p className="font-medium">查證來源</p>
                  {item.sources
                    .filter((source) => source.isUsed)
                    .map((source) =>
                      // 章節筆記沒有 URL，只能以純文字呈現。
                      source.url === null ? (
                        <p key={source.sourceId} className="block text-xs">
                          {source.sourceId}：{source.title}（你的章節筆記）
                        </p>
                      ) : (
                        <a
                          key={source.sourceId}
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block text-xs underline underline-offset-4"
                        >
                          {source.sourceId}：{source.title}（{source.domain}）
                        </a>
                      ),
                    )}
                </div>
              )}

              {item.reviewStatus === 'pending' ? (
                <div className="space-y-3 border-t pt-3">
                  <Field label="裁決備註（選填）">
                    <Input
                      value={notes[item.id] ?? ''}
                      onChange={(e) => setNotes((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      placeholder="記下你為什麼這樣裁決"
                    />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      disabled={resolve.isPending}
                      onClick={() => resolve.mutate({ id: item.id, decision: 'kept_original' })}
                    >
                      維持原答案
                    </Button>
                    <Button
                      disabled={resolve.isPending}
                      onClick={() =>
                        resolve.mutate({
                          id: item.id,
                          decision: 'answer_updated',
                          correctAnswers: item.verifiedAnswers,
                        })
                      }
                    >
                      改為 {item.verifiedAnswers.join('、')}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={resolve.isPending}
                      onClick={() => resolve.mutate({ id: item.id, decision: 'marked_disputed' })}
                    >
                      維持爭議標記
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={resolve.isPending}
                      onClick={() => resolve.mutate({ id: item.id, decision: 'question_excluded' })}
                    >
                      排除這題
                    </Button>
                  </div>
                </div>
              ) : (
                item.reviewNote && (
                  <p className="border-t pt-3 text-xs text-muted-foreground">
                    裁決備註：{item.reviewNote}
                  </p>
                )
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
