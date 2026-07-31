'use client';

import { Eye, EyeOff } from 'lucide-react';
import { forwardRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * 最小可用的 UI 原語，樣式沿用 shadcn/ui 的 token（globals.css 中的 CSS 變數）。
 * 隨著頁面變多，會逐步以 shadcn/ui 的正式元件取代。
 */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
};

export function Button({ className, variant = 'primary', ...props }: ButtonProps) {
  const variants = {
    primary: 'bg-primary text-primary-foreground hover:opacity-90',
    secondary: 'bg-secondary text-secondary-foreground hover:opacity-80',
    ghost: 'hover:bg-accent',
    danger: 'bg-destructive text-destructive-foreground hover:opacity-90',
  } as const;

  return (
    <button
      className={cn(
        'inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium transition',
        'disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-md border border-input bg-background px-3 text-sm',
        'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      {...props}
    />
  );
}

/**
 * 密碼輸入框，附顯示／隱藏切換。
 *
 * 用 forwardRef 是為了讓 React Hook Form 的 register() 能取得 ref。
 * 切換鈕標記 tabIndex={-1}，避免打斷「密碼 → 確認密碼 → 送出」的 Tab 流程。
 */
export const PasswordInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>
>(function PasswordInput({ className, ...props }, ref) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        ref={ref}
        type={visible ? 'text' : 'password'}
        className={cn(
          'h-9 w-full rounded-md border border-input bg-background px-3 pr-10 text-sm',
          'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
        {...props}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? '隱藏密碼' : '顯示密碼'}
        title={visible ? '隱藏密碼' : '顯示密碼'}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground transition hover:text-foreground"
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
});

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && !error && <span className="block text-xs text-muted-foreground">{hint}</span>}
      {error && <span className="block text-xs text-destructive">{error}</span>}
    </label>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-lg border bg-card p-6', className)}>{children}</div>;
}

/**
 * 錯誤提示。
 *
 * 一定要把 details 攤開顯示：後端的統一錯誤格式中，message 對驗證失敗來說
 * 只是「請求內容未通過驗證。」這種泛用句，真正有用的是逐欄位的 details。
 * 只顯示 message 會讓使用者完全不知道要改哪裡。
 */
export function ErrorBanner({
  message,
  details,
}: {
  message: string;
  details?: { path?: string; message: string }[];
}) {
  return (
    <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      <p>{message}</p>
      {details && details.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5">
          {details.map((detail, index) => (
            <li key={index}>
              {detail.path ? `${detail.path}：` : ''}
              {detail.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="rounded-lg border border-dashed px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}
