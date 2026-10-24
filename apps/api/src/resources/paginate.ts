import type { PaginatedResult } from '@kn0mic/reshaper';
import { z } from 'zod';

export const MAX_PER_PAGE = 100;

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(MAX_PER_PAGE).default(15),
});

export type PageParams = z.infer<typeof pageQuerySchema>;

/** Anything with Reshaper's static `paginate` (i.e. a Resource subclass). */
export interface Paginatable<Dto> {
  paginate(
    result: { data: unknown[]; total: number },
    options?: Record<string, unknown>,
  ): PaginatedResult<Dto>;
}

/**
 * Runs the rows query and the count query in parallel, then hands Reshaper `{ data, total }`.
 * Postgres returns count() as a bigint string and query params arrive as strings, so everything
 * is coerced to numbers here; Reshaper does math on them (Math.ceil(total / perPage)).
 */
export async function paginate<Row, Dto>(
  resource: Paginatable<Dto>,
  params: PageParams,
  queries: {
    rows: (limit: number, offset: number) => Promise<Row[]>;
    count: () => Promise<number | string | bigint>;
  },
  transformOptions: Record<string, unknown> = {},
): Promise<PaginatedResult<Dto>> {
  const page = Number(params.page);
  const perPage = Number(params.perPage);
  const [rows, rawTotal] = await Promise.all([
    queries.rows(perPage, (page - 1) * perPage),
    queries.count(),
  ]);
  const total = Number(rawTotal);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error(`paginate: invalid total ${String(rawTotal)}`);
  }
  return resource.paginate({ data: rows, total }, { ...transformOptions, page, perPage });
}
