---
status: COMPLETED
completed_at: 2026-09-22
summary: "권한 변경 transactional outbox·서명 웹훅·운영 UI와 공통 chat 계정 검색을 제공한다."
---

# Auth Execution

Canonical: [`AUTH_WEBHOOK_SHARED_CHAT_PLAN.md`](../../../.idea/completed/AUTH_WEBHOOK_SHARED_CHAT_PLAN.md).

- Permission approval/change/revoke and application rejection enqueue signed events in the same transaction as state changes.
- Persist service subscriptions and retryable outbox delivery; bound DNS/HTTP wall time, fence worker claims, recover expired final-attempt leases, and expose manual retry.
- Register endpoints through approved onboarding JSON/form, generated one-time or environment-backed secrets, explicit operator allowlist for internal origins.
- Admin lists subscription and five deliveries per page, supports disable/enable and one-time secret rotation. Display when dispatch is disabled by environment.
- Preserve refresh grant current-permission behavior; game consumes events without re-login. Add exact account lookup for chat using existing account.search credentials.
- Verify build/lint/unit/e2e, real PostgreSQL return shapes and locking, actual auth-to-game HTTP approval/renewal/revoke, browser import/manage controls.
- Migration is additive. Local auth backup is under workspace `.dev/backups/`; existing accounts/services/permissions must remain unchanged.

## Verification

- Build, lint and TypeScript checks passed. Unit tests: 16 suites / 72 passed. Fresh isolated PostgreSQL e2e: 2 suites / 41 passed.
- Real auth-to-game HTTP test passed: approval issues a current-role JWT under the existing service session, signed duplicate delivery is inert, and revocation invalidates the session.
- Browser tested JSON paste/file parity, malformed input, optional webhook configuration/removal, pagination, retry, secret rotation and responsive layout.
- All migrations ran successfully in an isolated DB. Only the new additive migration was applied to local auth after backup; accounts 10, services 6, assignments 14 before and after.
- No real webhook subscription or credential was seeded; delivery remains opt-in through environment and approved onboarding.
