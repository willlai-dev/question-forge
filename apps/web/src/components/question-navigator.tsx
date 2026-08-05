'use client';

import type { QuizOutlineItem, QuizOutlineResponse } from '@repo/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/**
 * 作答頁的跳題導覽。
 *
 * 滑過就展開、點一下釘住。**兩種都要有**：hover 在觸控裝置上不存在，
 * 只做 hover 等於在平板上直接沒有這個功能。
 *
 * 顏色一律由後端的 `isCorrect` 決定，前端不自行推測——
 * `null` 代表「還不能說」（交卷後模式尚未交卷，或這題根本沒作答），
 * 畫成中性色而不是紅色。把 null 當成 false 會讓整排空白題變成一片紅。
 */
export function QuestionNavigator({
  sessionId,
  position,
  onJump,
}: {
  sessionId: string;
  position: number;
  onJump: (position: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [preview, setPreview] = useState<QuizOutlineItem | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const outline = useQuery({
    queryKey: ['quiz-session', sessionId, 'outline'],
    queryFn: () => api.get<QuizOutlineResponse>(`/quiz-sessions/${sessionId}/outline`),
    // 作答會改變已答狀態，但導覽列不值得每次輪詢；
    // 由作答頁在送出答案後 invalidate。
    staleTime: 30_000,
  });

  // 滑開時延遲關閉，否則從觸發區移動到面板的路上就關掉了。
  const scheduleClose = () => {
    if (pinned) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 180);
  };
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  useEffect(() => () => cancelClose(), []);

  // 釘住之後點外面或按 Esc 才關得掉。
  useEffect(() => {
    if (!pinned) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPinned(false);
        setOpen(false);
      }
    };
    const onClickOutside = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setPinned(false);
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClickOutside);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClickOutside);
    };
  }, [pinned]);

  const items = outline.data?.items ?? [];
  const answered = items.filter((item) => item.answered).length;

  const jump = (target: number) => {
    onJump(target);
    if (!pinned) setOpen(false);
  };

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        onClick={() => {
          setPinned((was) => !was);
          setOpen(true);
        }}
        aria-expanded={open}
        aria-haspopup="true"
        className={cn(
          'flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition',
          open ? 'border-primary bg-accent' : 'hover:bg-accent/50',
        )}
      >
        <span className="font-medium">題目導覽</span>
        <span className="text-xs text-muted-foreground">
          {answered} / {items.length || '—'}
        </span>
        {pinned && <span className="text-xs text-primary">已釘選</span>}
      </button>

      {open && (
        <div
          className="absolute right-0 z-30 mt-2 w-[min(28rem,calc(100vw-2rem))] rounded-lg border bg-background p-3 shadow-lg"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {outline.isPending && <p className="text-sm text-muted-foreground">載入中…</p>}
          {outline.isError && (
            <p className="text-sm text-destructive">導覽載入失敗，可以直接用上一題／下一題。</p>
          )}

          {items.length > 0 && (
            <>
              <div className="grid grid-cols-8 gap-1.5">
                {items.map((item) => (
                  <button
                    key={item.sessionQuestionId}
                    type="button"
                    onClick={() => jump(item.position)}
                    onMouseEnter={() => setPreview(item)}
                    onFocus={() => setPreview(item)}
                    title={`第 ${item.position} 題`}
                    className={cn(
                      'relative rounded border py-1.5 text-sm tabular-nums transition',
                      statusClass(item),
                      item.position === position && 'ring-2 ring-primary ring-offset-1',
                    )}
                  >
                    {item.position}
                    {/* 自己標為重點的題目要找得回來，否則標了也沒用。 */}
                    {item.isFlagged && (
                      <span
                        className="absolute left-0.5 top-0.5 text-[10px] leading-none text-amber-500"
                        title="已標為重點"
                      >
                        ★
                      </span>
                    )}
                    {item.isProvisional && (
                      <span
                        className="absolute right-0.5 top-0.5 text-[10px] leading-none text-amber-600"
                        title="答案爭議待審"
                      >
                        ●
                      </span>
                    )}
                  </button>
                ))}
              </div>

              {/*
                滑過題號時顯示題幹前段。導覽列的用途是「認出是哪一題」，
                只有題號的話還是得一題一題點進去看。
              */}
              <div className="mt-3 min-h-[2.5rem] rounded border bg-muted/40 px-2 py-1.5 text-xs">
                {preview ? (
                  <>
                    <span className="text-muted-foreground">
                      第 {preview.position} 題 · 題號 {preview.questionNumber}
                      {preview.type === 'multiple_choice' && ' · 複選'}
                    </span>
                    <p className="mt-0.5 line-clamp-2 leading-relaxed">{preview.stemPreview}…</p>
                  </>
                ) : (
                  <span className="text-muted-foreground">滑過題號可預覽題幹。</span>
                )}
              </div>

              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <Legend className="border-emerald-500 bg-emerald-50 dark:bg-emerald-950" label="答對" />
                <Legend className="border-destructive bg-destructive/10" label="答錯" />
                <Legend className="border-primary bg-accent" label="已作答" />
                <Legend className="bg-muted/50" label="未作答" />
                <span className="flex items-center gap-1">
                  <span className="text-amber-500">★</span>
                  重點
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 題號的配色。
 *
 * `isCorrect === null` 時**不能**畫成答錯——那個 null 可能是「交卷後模式還沒交卷」，
 * 也可能是「這題還沒作答」，兩種都不是答錯。
 */
function statusClass(item: QuizOutlineItem): string {
  if (item.isCorrect === true) return 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950';
  if (item.isCorrect === false) return 'border-destructive bg-destructive/10';
  if (item.answered) return 'border-primary bg-accent';
  return 'bg-muted/50 hover:bg-accent/50';
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={cn('inline-block h-2.5 w-2.5 rounded border', className)} />
      {label}
    </span>
  );
}
