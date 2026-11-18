import type { EntityManager } from 'typeorm';

export const ACCOUNT_WRITE_LOCK = 'auth:last-active-superadmin';

// Linking locks a social transaction before the account; erasure does the reverse.
export async function lockAccountLifecycle(
  manager: EntityManager,
): Promise<void> {
  await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    ACCOUNT_WRITE_LOCK,
  ]);
}
