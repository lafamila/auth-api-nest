---
status: PREPARED
summary: "`/admin` dashboard pagination, active-only dashboard, and account soft delete UX/API safeguards를 구현한다."
---

# AUTH ADMIN USABILITY PLAN — auth-api-nest execution plan

Canonical orchestration plan:

`../../.idea/AUTH_ADMIN_USABILITY_PLAN.md`

## Repo Responsibility

`auth-api-nest` 는 이 idea 의 유일한 구현 대상이다.

- permission dashboard backend 를 server-side pagination API 로 변경한다.
- dashboard 기본 조회를 active account + active assignment 로 제한한다.
- `/admin` dashboard UI 를 paginated active-only table 로 바꾼다.
- accounts 목록에서 account soft delete 를 `status=disabled` 로 실행할 수 있게 한다.
- 마지막 active super admin disabled 방지 같은 안전장치를 server-side 에 둔다.
- 테스트와 빌드로 backend/API/UI 변경을 검증한다.

## Inputs / Dependencies

- Root canonical plan: `../../.idea/AUTH_ADMIN_USABILITY_PLAN.md`
- Existing dashboard service:
  - `src/domain/account-permissions/account-permissions.service.ts`
  - `src/domain/account-permissions/dto/permission-dashboard.dto.ts`
  - `src/admin/controllers/admin-permission-dashboard.controller.ts`
- Existing account update flow:
  - `src/admin/controllers/admin-accounts.controller.ts`
  - `src/domain/accounts/accounts.service.ts`
  - `src/domain/accounts/dto/account.dto.ts`
- Existing account status enum:
  - `src/database/entities/account.entity.ts`
- Existing admin UI:
  - `public/index.html`
- Existing e2e tests:
  - `test/app-bootstrap.e2e-spec.ts`

No DB migration is expected for Phase 1.

## Work Items

1. Add dashboard query/response DTOs.
   - Add query class for `page`, `pageSize`, `serviceKey`.
   - Default `page=1`, `pageSize=25`.
   - Clamp or reject invalid values; max `pageSize=100`.
   - Add paginated response DTO with `items`, `page`, `pageSize`, `total`, `totalPages`.

2. Change `AccountPermissionsService.listDashboardRows()` to paginated active-only query.
   - Filter account status to `active`.
   - Filter assignment status to `active`.
   - Optionally filter by `service.serviceKey`.
   - Return only default dashboard fields:
     - id
     - accountId/loginId/accountName/email
     - serviceId/serviceKey/serviceName
     - permissionDefinitionId/permissionKey/permissionLabel/permissionStatus
     - grantedAt/grantedByAccountId
   - Remove default response fields:
     - accountStatus
     - serviceStatus
     - assignmentStatus
     - revokedAt
   - Preserve deterministic ordering, newest first.

3. Update admin dashboard endpoint.
   - `GET /api/admin/permission-dashboard?page=&pageSize=&serviceKey=`
   - Use existing `AdminGuard`.
   - Return paginated object, not array.
   - Keep route path stable.

4. Add account soft delete safeguards.
   - Use existing `PATCH /api/admin/accounts/:accountId` with `{ status: 'disabled' }`.
   - In `AccountsService.update`, detect transition to disabled.
   - Prevent disabling the last active super admin.
   - Do not revoke account-service permissions.
   - Keep existing audit log.

5. Update `/admin` Accounts UI.
   - Add Actions column.
   - Add disable/soft-delete action for active non-protected accounts.
   - Confirm before disabling.
   - After success, refresh accounts and permission dashboard.
   - Do not present this as hard delete.

6. Update `/admin` Permission Dashboard UI.
   - Consume `{ items, page, pageSize, total, totalPages }`.
   - Keep service filter with `All services` default.
   - Add page size select: `10`, `25`, `50`, `100`.
   - Add previous/next buttons.
   - Show range text, e.g. `1-25 of 128`.
   - Reset page to 1 when service filter or page size changes.
   - Remove `Account status`, `Assignment status`, and `Revoked at` columns.
   - Keep update/revoke row actions. Re-fetch current dashboard page after actions.

7. Update tests.
   - Dashboard rejects missing/wrong admin key as before.
   - Dashboard returns paginated shape.
   - Dashboard returns only active accounts and active assignments.
   - Revoked assignment is excluded from default dashboard.
   - Disabled account is excluded from default dashboard.
   - `serviceKey` filter narrows rows.
   - `page`/`pageSize` metadata is correct.
   - Disabling ordinary account succeeds and does not revoke permissions.
   - Disabling the last active super admin fails.

8. Run verification.
   - `npm run lint`
   - `npm run test`
   - `npm run test:e2e`
   - `npm run build`
   - Extract `public/index.html` script and run `node --check` on it, or equivalent syntax check.

## Acceptance Criteria

- `GET /api/admin/permission-dashboard` returns:
  - `items`
  - `page`
  - `pageSize`
  - `total`
  - `totalPages`
- Dashboard API defaults to active account + active assignment rows only.
- Dashboard API supports `serviceKey`, `page`, and `pageSize`.
- Dashboard response no longer includes default `accountStatus`, `serviceStatus`, `assignmentStatus`, or `revokedAt` fields.
- `/admin` dashboard no longer renders `Account status`, `Assignment status`, or `Revoked at` columns.
- `/admin` dashboard has service filter, page size, previous/next, and current range UI.
- `/admin` account list can disable an active account via existing account update API.
- Disabled account cannot authenticate and does not appear in default permission dashboard.
- Disabling an account does not revoke existing permission assignments.
- Last active super admin cannot be disabled.
- Verification commands pass or failures are reported with exact failing output.

## Report Back To Orchestrator

- Report if dashboard pagination requires DB migration or new indexes.
- Report if changing dashboard response shape affects anything outside `/admin`.
- Report if last-super-admin protection needs a user decision beyond the safety rule in the root plan.
- Report exact verification commands and results.

## Decision Escalation

사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.
