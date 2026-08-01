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
  { href: '/subjects', label: '科目與章節' },
  { href: '/question-groups', label: '題組' },
  { href: '/questions', label: '題目' },
  { href: '/tags', label: '標籤' },
  { href: '/conflicts', label: '答案爭議' },
  { href: '/ai/jobs', label: 'AI 任務' },
  { href: '/imports', label: 'JSON 匯入' },
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
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-3">
          <span className="font-semibold">題庫分析</span>
          <nav className="flex gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm transition hover:bg-accent',
                  pathname.startsWith(item.href) && 'bg-accent font-medium',
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">{user?.displayName ?? user?.username}</span>
            <button
              className="text-muted-foreground underline-offset-4 hover:underline"
              onClick={() => logout.mutate()}
            >
              登出
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}
