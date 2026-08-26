import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_APP_NAME ?? '題庫分析系統',
  description: '選擇題題庫、作答、對答案與 AI 錯題分析系統',
};

/**
 * 行動裝置的視窗設定。
 *
 * `maximumScale` 與 `userScalable` 刻意**不設限**：限制縮放會讓視力不佳的人
 * 無法放大題幹，那是無障礙上的倒退。真正該解決的「點輸入框就整頁放大」問題
 * 是靠輸入元件在小螢幕維持 16px 字級（見 components/ui.tsx），不是靠鎖縮放。
 *
 * `viewportFit: 'cover'` 讓瀏海機的內容延伸到整個螢幕，實際的留白由
 * globals.css 的 safe-area padding 負責。
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#020817' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant" suppressHydrationWarning>
      <body className="min-h-screen bg-background antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
