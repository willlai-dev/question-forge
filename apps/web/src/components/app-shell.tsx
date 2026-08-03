'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { api, ApiRequestError, resetCsrfToken } from '@/lib/api-client';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/dashboard', label: '概況' },
  { href: '/quiz', label: '作答' },
  { href: '/mistakes', label: '錯題本' },
  { href: '/analysis/aggregate', label: '學習診斷' },
  { href: '/subjects', label: '科目與章節' },
  { href: '/question-groups', label: '題組' },
  { href: '/questions', label: '題目' },
  { href: '/tags', label: '標籤' },
  { href: '/conflicts', label: '答案爭議' },
  { href: '/ai/jobs', label: 'AI 任務' },
  { href: '/imports', label: 'JSON 匯入' },
  { href: '/settings', label: '設定' },
];

/** 已登入頁面的共用外框：導覽列 + 未登入時導回登入頁。 */
export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  const { data: user, error } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => api.get<{ username: string; displayName: string | null }>('/auth/me'),
    retry: false,
  });

  useEffect(() => {
    if (error instanceof ApiRequestError && error.status === 401) router.replace('/login');
  }, [error, router]);

  const logout = useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSuccess: () => {
      resetCsrfToken();
      router.replace('/login');
    },
  });

  return (
    <div className="min-h-screen">
      {/*
        表頭排成兩列，而不是把標題、導覽、帳號擠在同一列。
        導覽已有 12 項，光是項目本身加上內距就超過原本 max-w-5xl 的寬度，
        單列 flex 又沒有 flex-wrap，結果就是擠爆版面並把右側帳號區推出畫面外。
        拆成兩列之後導覽獨佔整行寬度，再加上 flex-wrap，項目再多也只會往下折。
      */}
      <header className="border-b">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex items-center justify-between gap-4 pt-3">
            <span className="shrink-0 font-semibold">題庫分析</span>
            <div className="flex shrink-0 items-center gap-3 text-sm">
              <span className="text-muted-foreground">{user?.displayName ?? user?.username}</span>
              <button
                className="text-muted-foreground underline-offset-4 hover:underline"
                onClick={() => logout.mutate()}
              >
                登出
              </button>
            </div>
          </div>
          <nav className="flex flex-wrap gap-1 pb-2.5 pt-2">
            {NAV.map((item) => {
              // 用「完全相同」或「後面接 /」判斷，避免 /questions 把 /question-groups 一起點亮。
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition hover:bg-accent',
                    active && 'bg-accent font-medium',
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}
