'use client';

import type { QuestionMark, QuestionResponse } from '@repo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/**
 * 單題的個人標記與註記。
 *
 * 在此之前，一道題目唯一會被「標出來」的方式是答錯。
 * 但看到重要的題目時未必答錯——那些題目原本沒有任何地方可以留下痕跡。
 *
 * **與答案揭露無關，因此不受 revealMode 限制**：標記自己的想法不會洩漏答案，
 * 交卷前也該能標。這正是最想標的時刻。
 */
export function QuestionMarkControl({
  questionId,
  mark,
  onSaved,
}: {
  questionId: string;
  mark: QuestionMark | null;
  /** 存檔後通知外層更新（例如作答頁重新拉題目）。 */
  onSaved?: (question: QuestionResponse) => void;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(mark?.note ?? '');

  // 換題時要跟著換內容，否則會把上一題的草稿帶過來。
  useEffect(() => {
    setDraft(mark?.note ?? '');
    setEditing(false);
  }, [questionId, mark?.note]);

  const save = useMutation({
    mutationFn: (body: { isFlagged?: boolean; note?: string | null }) =>
      api.put<QuestionResponse>(`/questions/${questionId}/mark`, body),
    onSuccess: (question) => {
      void qc.invalidateQueries({ queryKey: ['questions'] });
      void qc.invalidateQueries({ queryKey: ['quiz-session'] });
      onSaved?.(question);
    },
  });

  const error = save.error instanceof ApiRequestError ? save.error : null;
  const flagged = mark?.isFlagged ?? false;

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={flagged ? 'primary' : 'secondary'}
          disabled={save.isPending}
          onClick={() => save.mutate({ isFlagged: !flagged })}
        >
          {flagged ? '★ 已標為重點' : '☆ 標為重點'}
        </Button>

        {!editing && (
          <Button variant="secondary" onClick={() => setEditing(true)} disabled={save.isPending}>
            {mark?.note ? '編輯註記' : '加註記'}
          </Button>
        )}

        {mark?.note && !editing && (
          <span className="text-xs text-muted-foreground">已寫下註記</span>
        )}
      </div>

      {/* 沒在編輯時直接把註記顯示出來——寫了卻要再點一次才看得到就沒有意義。 */}
      {mark?.note && !editing && (
        <p className="whitespace-pre-wrap rounded bg-background px-2 py-1.5 text-sm leading-relaxed">
          {mark.note}
        </p>
      )}

      {editing && (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={2000}
            autoFocus
            placeholder="例如：這題的但書容易漏看；C 選項和第三章的概念很像"
            className={cn(
              'w-full rounded-md border border-input bg-background px-3 py-2 text-sm',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          />
          <div className="flex gap-2">
            <Button
              disabled={save.isPending}
              onClick={() => {
                save.mutate({ note: draft });
                setEditing(false);
              }}
            >
              {save.isPending ? '儲存中…' : '儲存註記'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(mark?.note ?? '');
                setEditing(false);
              }}
            >
              取消
            </Button>
            {mark?.note && (
              <Button
                variant="secondary"
                disabled={save.isPending}
                onClick={() => {
                  save.mutate({ note: null });
                  setEditing(false);
                }}
              >
                刪除註記
              </Button>
            )}
          </div>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error.message}</p>}
    </div>
  );
}
