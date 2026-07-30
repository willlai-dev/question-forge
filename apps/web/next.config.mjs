/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 只有 NEXT_PUBLIC_* 會進入 bundle；後端機密不會、也不應出現在這裡。
  // 對應 prompt.md 環境變數章第 9、10 點。
  poweredByHeader: false,
  eslint: {
    // Lint 由 repo 根目錄的 flat config 統一執行（pnpm lint），避免兩套設定互相打架。
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
