---
status: COMPLETED
summary: "`/admin` key handling을 session-only로 바꾸고 permission dashboard API/UI를 구현한다."
completed_at: 2026-05-24
completion_reason: "backend endpoints, admin UI lifecycle controls, tests, lint, build, and e2e verification completed"
---

# AUTH ADMIN CONSOLE PLAN — auth-api-nest execution plan

Canonical orchestration plan:

`../../.idea/completed/AUTH_ADMIN_CONSOLE_PLAN.md`

## Repo Responsibility

`auth-api-nest` 는 이 idea 의 유일한 구현 대상이다.

- admin console static UI (`public/index.html`) 를 안전하게 수정한다.
- 계정-서비스-권한 현황을 반환하는 admin API 를 추가한다.
- 실제 등록된 account/service/permission/client/credential 을 `/admin` 에서 수정, revoke, 비활성화, 삭제성 처리할 수 있게 한다.
- 새 서비스 등록 workflow help 를 한글 모달로 제공한다.
- admin guard, permission assignment, service registry 기존 계약을 깨지 않는다.
- 테스트와 빌드로 backend/API/UI 변경을 검증한다.

## Inputs / Dependencies

- Root canonical plan: `../../.idea/completed/AUTH_ADMIN_CONSOLE_PLAN.md`
- Existing admin guard: `src/admin/admin.guard.ts`
- Existing account-service permission entity:
  - `src/database/entities/account-service-permission.entity.ts`
  - eager relations: `account`, `service`, `permissionDefinition`
- Existing service:
  - `src/domain/account-permissions/account-permissions.service.ts`
- Existing controller:
  - `src/admin/controllers/admin-accounts.controller.ts`
- Existing admin UI:
  - `public/index.html`

No DB migration is expected for Phase 1.

If lifecycle actions require new columns for true archival metadata, report to the orchestrator before changing schema. Prefer existing status fields and existing revoke/deprecate/rotate semantics first.

## Work Items

1. Add permission dashboard backend query.
   - Add `listDashboardRows()` to `AccountPermissionsService`.
   - Query all `AccountServicePermissionEntity` rows with account/service/permission relations available.
   - Sort by newest grant/change first, for example `grantedAt DESC`, `createdAt DESC`.
   - Return a plain DTO array instead of raw entity objects.

2. Add admin dashboard endpoint.
   - Add `GET /api/admin/permission-dashboard`.
   - Use existing `AdminGuard`.
   - Prefer a small dedicated controller, for example `AdminPermissionDashboardController`, or add to an existing admin controller if that keeps the module simpler.
   - Register the controller in `AdminModule`.

3. Add/adjust tests.
   - Dashboard endpoint rejects missing/wrong `x-admin-key`.
   - Dashboard endpoint returns created assignment rows with:
     - account loginId/name/email/status/isSuperAdmin
     - service key/name/status
     - permission key/label/status
     - assignment status/grantedAt/revokedAt/grantedByAccountId
   - Existing e2e bootstrap test is a good place if it already creates account/service/permission assignment.

4. Fix `/admin` key persistence.
   - Replace `localStorage` with `sessionStorage`.
   - Remove fallback `'dev-admin-key'`.
   - Initial input value must be `sessionStorage.getItem('teddy-auth-admin-key') || ''`.
   - `api()` should fail fast with a clear UI error if key is empty, before making fetch.
   - `refreshAll()` must not auto-call admin APIs when key is missing.
   - Save Key stores only non-empty input in sessionStorage.
   - Add Clear Key button that clears input and sessionStorage.

5. Remove sensitive placeholders/examples.
   - Audit all inputs/textareas in `public/index.html`.
   - Remove placeholder values that look like real login IDs, emails, domains, redirect URIs, service keys, client IDs, client secrets, or admin keys.
   - It is acceptable to leave placeholder empty.

6. Add permission dashboard UI.
   - Add a section titled `Account-Service Permission Dashboard`.
   - Add controls:
     - refresh dashboard button
     - service filter
     - assignment status filter
     - permission key filter
     - account search input
   - Add flat table columns:
     - Account
     - Name
     - Email
     - Account status
     - Service key
     - Service name
     - Permission key
     - Permission label
     - Permission status
     - Assignment status
     - Granted at
     - Revoked at
   - Store rows in `state.permissionDashboard`.
   - Render filters client-side.
   - Refresh dashboard after account permission put/revoke and service application approve/reject.

7. Add registered-item lifecycle controls.
   - Account-service permissions:
     - Add a dashboard row action to revoke an active assignment.
     - Support updating the permission level for an existing account/service pair.
     - Refresh dashboard after update/revoke.
   - Service credentials:
     - Show existing credentials for a selected service.
     - Add UI/API support to update non-secret metadata such as name/description/scopes/expiresAt/status if the backend does not already expose it.
     - Keep secret write-only: never display existing secret.
     - Support rotate and disable/revoke/archive.
     - Treat delete as disable/archive unless a safe hard-delete API already exists and can preserve audit expectations.
   - OIDC clients:
     - Expose edit controls for redirect URIs, client type, status, and display metadata.
     - Support client secret rotate without showing the old secret.
     - Support disable/archive/delete-style lifecycle action according to the existing backend contract.
   - Service permission definitions:
     - Add edit controls for label/description/status.
     - Wire existing deprecate/migrate/remove flows into the UI.
     - Show the impact on existing assignments before migration/remove.
   - Services/accounts:
     - Expose safe metadata/status edits where existing admin APIs support them.
     - Do not add destructive hard-delete for core service/account rows without explicit orchestrator/user decision.

8. Add Korean workflow help modal.
   - Place a floating help button near or above Admin Access.
   - Write user-facing copy in Korean.
   - Explain the new-service setup flow:
     - register service
     - register permission definitions
     - create OIDC client when browser login is needed
     - create service credential when backend-to-auth calls are needed
     - put service credential id/secret only in backend env/secret storage
     - restart or reload the target backend
     - grant account-service permissions
   - Do not include realistic secret, admin key, client secret, email, or production-domain examples in the help text.

9. Run verification.
   - `npm run lint`
   - `npm run test`
   - `npm run test:e2e`
   - `npm run build`

## Acceptance Criteria

- `/admin` no longer pre-fills `x-admin-key` with `dev-admin-key` or any env/default value.
- `/admin` uses `sessionStorage`, not `localStorage`, for the key.
- Clear Key removes the stored key for the current browser tab session.
- `/admin` does not automatically call admin APIs when the key is empty.
- No input placeholder exposes realistic secret/account/domain/client data.
- `GET /api/admin/permission-dashboard` is protected by `AdminGuard`.
- Dashboard endpoint returns account-service permission rows with account, service, permission, and assignment status fields.
- UI dashboard can filter by service, assignment status, permission key, and account search text.
- Permission assignment/revoke/application approval flows refresh dashboard state.
- Dashboard row actions can revoke active account-service permission assignments.
- Existing account/service permission level can be updated from the admin UI.
- Service credentials can be listed and managed without exposing stored secrets:
  - metadata/status update where supported
  - rotate
  - disable/revoke/archive
- OIDC clients can be edited and client secrets can be rotated without exposing old secrets.
- Service permission definitions can be edited, deprecated, migrated, or removed from the admin UI, with existing-assignment impact shown before risky actions.
- User-facing workflow help text is Korean.
- Delete-style actions either map to safe disable/revoke/archive behavior or require explicit confirmation and clear warning.
- Verification commands pass or failures are reported with exact failing output.

## Report Back To Orchestrator

- If implementing dashboard API reveals missing relation data or a DB migration need, stop and report before changing schema.
- If admin UI needs a larger layout rewrite than this plan assumes, report the scope increase before broad refactor.
- If `AUTH_SERVICE_KEYS_PLAN.md` becomes necessary to complete the work, report the dependency instead of folding it into this idea.
- If hard delete semantics are needed for service credentials, OIDC clients, accounts, services, or permission definitions, stop and report before adding destructive deletion.
- Report exact verification commands and results.

## Decision Escalation

사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.
