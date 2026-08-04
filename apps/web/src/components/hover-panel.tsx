'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * 滑過展開的浮動面板。
 *
 * 這個互動有三個非做不可的細節，少一個就不好用：
 *
 *   1. **離開觸發區要延遲關閉。** 立刻關的話，滑鼠從觸發區移動到面板的路上就關掉了。
 *   2. **面板本身也要接住滑鼠。** 否則面板一展開、滑鼠移進去就算「離開觸發區」。
 *      內容可捲動時這點特別關鍵——不接住就永遠捲不到。
 *   3. **要能點擊釘選。** 觸控裝置沒有 hover，只做 hover 等於在平板上沒有這個功能。
 *
 * 註：`question-navigator.tsx` 有一份更早、行為相同的實作。
 * 它的觸發按鈕需要依 open 狀態改樣式，與這裡的介面不合，暫時沒有合併。
 */
const CLOSE_DELAY_MS = 180;

export function HoverPanel({
  children,
  panel,
  align = 'left',
  panelClassName,
  triggerClassName,
  label,
}: {
  /** 觸發區內容。 */
  children: ReactNode;
  /** 彈出內容。 */
  panel: ReactNode;
  align?: 'left' | 'right';
  panelClassName?: string;
  triggerClassName?: string;
  /** 給輔助技術與滑鼠停留提示用。 */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const cancelClose = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  const scheduleClose = (): void => {
    if (pinned) return;
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  useEffect(() => cancelClose, []);

  // 釘選之後只有點外面或按 Esc 才關得掉。
  useEffect(() => {
    if (!pinned) return;

    const close = (): void => {
      setPinned(false);
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    const onPointerDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) close();
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [pinned]);

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
        aria-expanded={open}
        aria-haspopup="dialog"
        title={label}
        onClick={() => {
          setPinned((was) => !was);
          setOpen(true);
        }}
        className={triggerClassName}
      >
        {children}
      </button>

      {open && (
        <div
          role="dialog"
          className={cn(
            'absolute z-30 mt-1 rounded-lg border bg-background p-3 shadow-lg',
            align === 'right' ? 'right-0' : 'left-0',
            panelClassName,
          )}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {panel}
        </div>
      )}
    </div>
  );
}
