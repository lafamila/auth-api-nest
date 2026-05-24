---
status: COMPLETED
completed_at: 2026-05-24
completion_reason: "Implemented and verified auth service credential backend, admin UI, internal account search, docs, and tests."
summary: "auth admin key와 분리된 service credential 모델/API/guard/internal account search/admin UI를 구현한다."
---

# AUTH SERVICE KEYS PLAN — auth-api-nest execution plan

Canonical orchestration plan:

`../../.idea/AUTH_SERVICE_KEYS_PLAN.md`

## Repo Responsibility

`auth-api-nest` 는 service credential 의 source of truth 다.

- service credential entity/migration/service 를 추가한다.
- admin guard 와 별개의 internal service credential guard 를 추가한다.
- service credential 관리 admin API 를 추가한다.
- `todo-api-fastapi` 가 사용할 internal account search endpoint 를 제공한다.
- admin console 에 credential 관리 UI 를 추가한다.
- docs/tests/build 로 계약을 검증한다.

## Inputs / Dependencies

- Root canonical plan: `../../.idea/AUTH_SERVICE_KEYS_PLAN.md`
- Existing admin key guard: `src/admin/admin.guard.ts`
- Existing account search logic: `src/domain/accounts/accounts.service.ts`
- Existing service registry: `src/domain/service-registry/*`
- Existing audit log service: `src/domain/audit-logs/audit-logs.service.ts`
- Existing admin console: `public/index.html`
- Existing docs: `docs/admin-api.md`

## Work Items

1. Add DB model and migration.
   - Create `ServiceCredentialEntity`.
   - Suggested table: `service_credentials`.
   - Columns:
     - `id uuid primary key`
     - `service_id uuid not null references services(id)`
     - `key_id varchar unique not null`
     - `secret_hash varchar not null`
     - `name varchar not null`
     - `description text default ''`
     - `scopes text[]` or JSON column depending on existing TypeORM/Postgres style
     - `status varchar default 'active'`
     - `expires_at timestamptz null`
     - `last_used_at timestamptz null`
     - `last_used_from varchar null`
     - `rotated_at timestamptz null`
     - `disabled_at timestamptz null`
     - timestamps
   - Status union: `active | disabled`.
   - Scope union Phase 1: `account.search | permission.read`.

2. Add service credential module.
   - `src/domain/service-credentials/service-credentials.module.ts`
   - `service-credentials.service.ts`
   - DTOs for create/list/rotate/disable.
   - Generate high-entropy random raw secret with `crypto.randomBytes`.
   - Generate stable unique `keyId`.
   - Store only `argon2` hash of secret.
   - Create/rotate returns raw secret once.
   - List never returns raw secret or hash.

3. Add admin management controller.
   - Suggested file: `src/admin/controllers/admin-service-credentials.controller.ts`
   - Endpoints:
     - `POST /api/admin/services/:serviceId/credentials`
     - `GET /api/admin/services/:serviceId/credentials`
     - `POST /api/admin/services/:serviceId/credentials/:credentialId/rotate`
     - `POST /api/admin/services/:serviceId/credentials/:credentialId/disable`
   - Protect with existing `AdminGuard`.
   - Register in `AdminModule`.
   - Record audit logs for create/rotate/disable.

4. Add internal service credential guard.
   - Headers:
     - `x-auth-service-key-id`
     - `x-auth-service-secret`
   - Verify:
     - credential exists
     - status is active
     - not expired
     - secret matches hash
   - Attach verified credential/service/scopes to request.
   - Do not let admin key pass this guard.

5. Add internal account search endpoint.
   - Suggested controller: `src/internal/internal-service-accounts.controller.ts`.
   - Endpoint:
     - `GET /api/internal/service-accounts/search?serviceKey=todo&q=...`
   - Require `account.search` scope.
   - Check credential service key equals query `serviceKey`; otherwise `403`.
   - Reuse `AccountsService.searchForService(serviceKey, q)`.
   - Preserve current response shape expected by `todo-api-fastapi`.
   - Update `lastUsedAt` and best-effort `lastUsedFrom`.

6. Add admin console UI for service credentials.
   - Under Services or a new Service Credentials section.
   - Select a service.
   - List credential key id/name/scopes/status/last used/expiry.
   - Create credential form:
     - name
     - description
     - scopes checkboxes (`account.search`, `permission.read`)
     - optional expiresAt
   - Rotate/disable buttons.
   - Raw secret shown only immediately after create/rotate.
   - Do not store raw secret in localStorage/sessionStorage.

7. Update docs.
   - `docs/admin-api.md`:
     - clarify `x-admin-key` is admin-only
     - document service credential admin endpoints
     - document internal account search endpoint
   - `.env.example`:
     - keep `ADMIN_API_KEY` as auth admin only
     - do not add service secrets to auth repo unless needed for tests.

8. Add tests.
   - e2e or integration coverage for:
     - admin can create/list/rotate/disable credential
     - list response excludes raw secret/hash
     - internal search rejects missing/wrong headers
     - internal search rejects disabled credential
     - internal search rejects missing scope
     - internal search rejects mismatched serviceKey
     - internal search returns account rows for valid todo credential
   - Existing `test/app-bootstrap.e2e-spec.ts` can be extended if appropriate.

9. Run verification.
   - `npm run lint`
   - `npm run test`
   - `npm run test:e2e`
   - `npm run build`

## Acceptance Criteria

- `x-admin-key` remains valid only for `/api/admin/**`.
- Service credential cannot call `/api/admin/**`.
- Admin key cannot call `/api/internal/service-accounts/search`.
- `service_credentials` stores secret hash only.
- Raw secret appears only in create/rotate API response and transient UI display.
- Valid todo credential with `account.search` can call account search for `serviceKey=todo`.
- Valid todo credential cannot call account search for another service key.
- Disabled/expired/wrong-scope/wrong-secret credentials fail.
- Audit logs are recorded for create/rotate/disable.
- Verification commands pass or exact failures are reported.

## Report Back To Orchestrator

- If a DB schema choice requires user-visible migration or data loss, stop and report.
- If existing `AccountsService.searchForService()` response shape must change, report before changing it because `todo-api-fastapi` depends on it.
- If admin console implementation overlaps with `AUTH_ADMIN_CONSOLE_PLAN.md`, keep changes compatible and report any shared UI conflict.
- Report the final env names and endpoint paths for `todo-api-fastapi`.

## Decision Escalation

사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.
