/**
 * @repo/contracts —— 前後端唯一的契約來源。
 *
 * Phase 0 已完成：環境變數 Schema、統一錯誤格式。
 * Phase 1 起會陸續加入：API DTO、題庫匯入格式、AI 輸入輸出 Schema。
 * 對應設計文件見 docs/API_CONTRACT.md 與 docs/AI_ANALYSIS_SCHEMAS.md。
 */

export * from './env';
export * from './errors';

export * from './api/common';
export * from './api/auth';
export * from './api/question-bank';
export * from './api/questions';
export * from './api/quiz';
export * from './api/mistakes';
export * from './api/settings';
export * from './api/stats';
export * from './api/tags';
export * from './api/ai';

export * from './import/types';
export * from './import/validate';

export * from './quiz/index';
export * from './tags/index';
export * from './ai/index';
export * from './analysis/index';

// 注意：content-hash 刻意「不」從這裡匯出。
// 它依賴 node:crypto，而本套件同時被 Next.js 前端 bundle 引用 ——
// 一旦放進主 barrel，webpack 會因為無法解析 node: scheme 而建置失敗。
// 伺服器端請改用 `@repo/contracts/server`。
