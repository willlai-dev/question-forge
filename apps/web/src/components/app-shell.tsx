'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

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

/** 用「完全相同」或「後面接 /」判斷，避免 /questions 把 /question-groups 一起點亮。 */
function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** 已登入頁面的共用外框：導覽列 + 未登入時導回登入頁。 */
export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const { data: user, error } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => api.get<{ username: string; displayName: string | null }>('/auth/me'),
    retry: false,
  });

  useEffect(() => {
    if (error instanceof ApiRequestError && error.status === 401) router.replace('/login');
  }, [error, router]);

  /*
   * 換頁就把選單關掉。
   *
   * 手機選單點下去之後是 client-side 導覽，元件不會卸載——不主動關的話，
   * 使用者會看到新頁面被選單整個蓋住，還得再點一次才看得到內容。
   */
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // 選單展開時鎖住背景捲動，否則手指在選單上滑會帶著後面的頁面一起動。
  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);

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
        表頭在桌機排成兩列：標題與帳號一列、導覽獨佔一列。
        導覽有 12 項，光是項目本身加上內距就超過 max-w-6xl 的一半，
        擠在同一列會把右側帳號區推出畫面外。

        手機則完全換一套：12 個項目就算會折行，也會佔掉螢幕近三分之一的高度，
        每一頁都得先捲過它才看得到內容。因此改成漢堡選單，
        表頭固定只有一列，而且 sticky —— 手機上頁面通常很長，
        捲到一半想換頁卻得先捲回最上面是很煩的事。
      */}
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex items-center justify-between gap-3 py-3 sm:pb-0 sm:pt-3">
            <Link href="/dashboard" className="shrink-0 font-semibold">
              題庫分析
            </Link>

            <div className="flex shrink-0 items-center gap-2 text-sm sm:gap-3">
              <span className="hidden max-w-[10rem] truncate text-muted-foreground sm:inline">
                {user?.displayName ?? user?.username}
              </span>
              <button
                className="hidden text-muted-foreground underline-offset-4 hover:underline sm:inline"
                onClick={() => logout.mutate()}
              >
                登出
              </button>

              {/* 漢堡鈕只在手機出現；44px 見方是觸控目標的下限。 */}
              <button
                type="button"
                aria-label={menuOpen ? '關閉選單' : '開啟選單'}
                aria-expanded={menuOpen}
                aria-controls="mobile-nav"
                onClick={() => setMenuOpen((open) => !open)}
                className="-mr-2 flex h-11 w-11 items-center justify-center rounded-md transition hover:bg-accent sm:hidden"
              >
                {menuOpen ? <X size={20} /> : <Menu size={20} />}
              </button>
            </div>
          </div>

          {/* 桌機的橫向導覽。手機一律走下面的抽屜。 */}
          <nav className="hidden flex-wrap gap-1 pb-2.5 pt-2 sm:flex">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition hover:bg-accent',
                  isActive(pathname, item.href) && 'bg-accent font-medium',
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          {/*
            手機抽屜掛在表頭底下（top-full），不是自己算一個 top 值。
            表頭高度會隨字級與安全區變動，寫死數字遲早會對不上，
            出現「選單浮在標題上」或「中間卡一條縫」。
          */}
          {menuOpen && (
            <MobileNav
              pathname={pathname}
              username={user?.displayName ?? user?.username ?? ''}
              onLogout={() => logout.mutate()}
            />
          )}
        </div>
      </header>

      {/*
        遮罩要在表頭（z-40）之下、內容之上，因此放在 header 外面用 z-30。
        放進 header 裡會被抽屜的定位脈絡限制住，蓋不到整個畫面。
      */}
      {menuOpen && (
        <button
          type="button"
          aria-label="關閉選單"
          tabIndex={-1}
          onClick={() => setMenuOpen(false)}
          className="fixed inset-0 z-30 bg-foreground/20 sm:hidden"
        />
      )}

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">{children}</main>
    </div>
  );
}

/**
 * 手機的導覽抽屜。
 *
 * 用兩欄網格而不是單欄清單：12 個項目排成單欄在小螢幕上要捲兩屏才看得完，
 * 兩欄剛好一屏內放得下，不必捲動就能選到任何一頁。
 */
function MobileNav({
  pathname,
  username,
  onLogout,
}: {
  pathname: string;
  username: string;
  onLogout: () => void;
}) {
  return (
    <nav
      id="mobile-nav"
      className="absolute inset-x-0 top-full max-h-[75vh] overflow-y-auto border-b bg-background px-4 pb-safe pt-3 shadow-lg sm:hidden"
    >
      <div className="grid grid-cols-2 gap-1.5">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex min-h-11 items-center rounded-md px-3 text-sm transition',
              isActive(pathname, item.href) ? 'bg-accent font-medium' : 'hover:bg-accent',
            )}
          >
            {item.label}
          </Link>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between border-t pt-3 text-sm">
        <span className="min-w-0 truncate text-muted-foreground">{username}</span>
        <button
          className="min-h-11 shrink-0 px-2 text-muted-foreground underline-offset-4 hover:underline"
          onClick={onLogout}
        >
          登出
        </button>
      </div>
    </nav>
  );
}
