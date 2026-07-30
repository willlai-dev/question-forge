import { z } from 'zod';

/** UUID 路徑參數。 */
export const uuidSchema = z.string().uuid('必須是合法的 UUID');

export const idParamSchema = z.object({ id: uuidSchema });
export type IdParam = z.infer<typeof idParamSchema>;

/** 列表端點共用的分頁查詢。查詢字串一律是字串，故使用 coerce。 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const paginationMetaSchema = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});
export type PaginationMeta = z.infer<typeof paginationMetaSchema>;

/** 包裝成 { items, pagination } 的列表回應。 */
export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    pagination: paginationMetaSchema,
  });
}

/** 批次重新排序：依陣列順序寫入 sort_order。 */
export const reorderRequestSchema = z
  .object({
    orderedIds: z.array(uuidSchema).min(1, '至少需要一個項目'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const unique = new Set(value.orderedIds);
    if (unique.size !== value.orderedIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orderedIds'],
        message: 'orderedIds 不得包含重複的 ID',
      });
    }
  });
export type ReorderRequest = z.infer<typeof reorderRequestSchema>;

/** 供刪除等無內容回應使用。 */
export const okResponseSchema = z.object({ ok: z.literal(true) });
