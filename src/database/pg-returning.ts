/**
 * TypeORM's `query()` returns `[rows, affectedCount]` for `UPDATE/DELETE ...
 * RETURNING` on Postgres, while a plain rows array is used by unit fakes and
 * other drivers. Normalize both shapes to the first returned row (or undefined).
 */
export function extractReturnedRow<T>(result: unknown): T | undefined {
  if (!Array.isArray(result)) {
    return undefined;
  }
  const rows = Array.isArray(result[0]) ? (result[0] as unknown[]) : result;
  return rows[0] as T | undefined;
}
