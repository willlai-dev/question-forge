import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages}/**/src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    environment: 'node',
    // 單元測試不碰資料庫與外部服務，因此可放心平行執行。
    //
    // 刻意**不設** passWithNoTests。Phase 0 沒有任何測試時它是必要的，
    // 但現在有 327 個測試，留著只會製造一種最糟的失敗模式：
    // 上面的 include 若哪天不再對到檔案（改路徑、搬目錄），
    // `pnpm verify` 會在一個測試都沒跑的情況下回報全綠。
    // 「沒有測試被執行」本身就該是失敗。
  },
});
