import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

// shadcn/ui 標準設定：色彩以 CSS 變數表示，明暗主題共用同一組 token。
const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      /*
       * 預設最小斷點 sm 是 640px，對手機來說太粗：
       * 360px 與 430px 的螢幕之間差了快兩成寬度，卻套用同一組樣式。
       * xs 補上這一段，主要用在題號網格、統計卡這類會排多欄的地方。
       */
      screens: { xs: '475px' },
      /*
       * 固定在底部的操作列要避開 iPhone 的 home indicator。
       *
       * 定義成 theme 值而不是 globals.css 裡的自訂 class，是為了讓它進入
       * Tailwind 的工具類排序：手寫 class 會落在產生的 utilities 之後，
       * 連 `sm:pb-0` 都蓋不掉它，桌機上就會莫名多出一段留白。
       */
      padding: { safe: 'calc(env(safe-area-inset-bottom) + 0.75rem)' },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [animate],
};

export default config;
