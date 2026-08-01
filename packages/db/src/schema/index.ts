/**
 * Drizzle schema 匯總點。
 *
 * 依 docs/ERD.md 實作。目前涵蓋 Phase 1 的 13 張表；
 * Phase 2 起會依序加入作答、標籤與 AI 相關資料表。
 */

export * from './_shared';
export * from './identity';
export * from './question-bank';
export * from './import';
export * from './tags';
export * from './quiz';
export * from './ai';
