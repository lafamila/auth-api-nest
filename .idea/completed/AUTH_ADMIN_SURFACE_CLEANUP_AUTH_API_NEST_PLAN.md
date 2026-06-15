---
status: COMPLETED
summary: "admin console과 admin write API를 service onboarding 중심 운영 모델에 맞게 정리한다."
completed_at: 2026-06-15
completion_reason: "Admin direct-write surface removed, service onboarding UI added, OTP QR added, lazy visitor assignment implemented, and verification passed."
---

# AUTH_ADMIN_SURFACE_CLEANUP_PLAN — auth-api-nest execution plan

Canonical orchestration plan:

`../.idea/AUTH_ADMIN_SURFACE_CLEANUP_PLAN.md`

## Repo Responsibility
`auth-api-nest`는 이번 변경의 유일한 구현 대상이다. `/admin` UI, admin controller route surface, service onboarding approval UI, OTP registration QR 표시, 관련 tests를 모두 이 repo에서 처리한다.

## Inputs / Dependencies
- Root canonical plan의 확정 결정:
  - admin 직접 생성/수정 UI 제거.
  - admin 내부 API도 직접 생성/수정 route를 제거하거나 비활성화.
  - 서비스 추가/수정은 service onboarding request approve에서만 실제 반영.
  - 계정 생성은 `/signup`으로 이동. admin은 account disable/reset만 유지.
  - service credential은 list/rotate/disable만 유지.
  - account-service permission 직접 assign/revoke 제거. service application approve/reject만 유지.
  - OTP QR 구현에 `qrcode` npm package 추가 허용.
  - service onboarding request approve/reject UI는 반드시 `/admin`에 추가.
  - account 생성이나 service 생성/승인 시 모든 service/account 조합에 visitor assignment를 벌크 생성하지 않음.
  - 특정 서비스에 최초 로그인할 때 account는 active이고 service/client도 active이며 해당 account-service permission row가 전혀 없으면 visitor assignment를 lazy 생성하고 그 권한으로 token을 발급.
  - 기존 row가 revoked/disabled 등 비활성 상태이면 lazy visitor로 자동 복구하지 않음.
- 기존 admin session, bootstrap, signup, service onboarding, service application, credential rotate/disable 기능은 유지해야 한다.

## Work Items

1. 현재 route와 UI 사용처를 매핑한다.
   - `public/index.html`의 form id와 event listener를 확인한다.
   - admin controllers에서 직접 write route를 확인한다.
   - e2e 테스트에서 제거될 route를 호출하는 부분을 찾아 새 기대값으로 바꾼다.

2. `/admin` direct-create forms를 제거한다.
   - 제거 대상: `accountForm`, `serviceForm`, `credentialForm`, `permissionForm`, `clientForm`, `assignmentForm`.
   - 관련 select population, event listeners, state writes를 함께 정리한다.
   - `Services`, `Permissions`, `OIDC Clients`, `Service Credentials`, `Permission Dashboard`는 read-oriented sections로 유지한다.

3. read-only table로 전환한다.
   - Permissions table에서 inline edit, deprecate/migrate/remove controls 제거.
   - OIDC clients table에서 inline edit, rotate, disable controls 제거.
   - Permission Dashboard에서 permission select/action 제거.
   - Service Credentials table은 mutable name/description/scopes/expires/status controls 제거.
   - Service Credentials table에는 rotate와 disable button만 유지한다.
   - Accounts table은 disable action과 reset password action을 유지한다. reset password UI가 없다면 추가한다.

4. service onboarding request UI를 추가한다.
   - 새 section title 예: `Service Onboarding Requests`.
   - status filter: all/pending/approved/rejected.
   - page size 5 pagination.
   - list row: serviceKey, kind, status, revision, requesterName/requesterEmail, createdAt, decidedAt.
   - requestedSpec 요약/상세 표시.
   - pending row에 approve/reject action.
   - reject reason 입력 UI.
   - approve 응답의 `secrets`를 transient secret card로 표시.
   - 기존 `Service Applications` section은 `Account Access Requests` 등으로 이름을 바꿔 service onboarding과 구분한다.

5. bootstrap-only screen mode를 고친다.
   - `/api/admin/bootstrap/status`가 bootstrap required를 나타낼 때 `adminMain`을 숨긴다.
   - bootstrap 전에는 workflow help/admin internal content가 노출되지 않게 한다.
   - bootstrap panel은 자동 또는 명확하게 열려야 한다.
   - session 존재 시에만 adminMain과 refresh controls가 활성화된다.

6. OTP QR registration을 구현한다.
   - `qrcode` dependency를 추가한다.
   - `bootstrap/start` 응답의 `otpauthUri`를 QR로 표시한다.
   - QR 외에도 secret/otpauth URI fallback을 계속 표시한다.
   - frontend bundler가 없는 정적 HTML 구조이므로, qrcode browser asset을 어떻게 제공할지 구현 시 결정하되 외부 CDN 의존은 피한다.

7. admin backend route surface를 정리한다.
   - 제거 대상 route:
     - `POST /api/admin/accounts`
     - `POST /api/admin/services`
     - core spec 직접 변경용 `PATCH /api/admin/services/:serviceId`
     - `POST /api/admin/services/:serviceId/permissions`
     - `PATCH /api/admin/services/:serviceId/permissions/:permissionId`
     - `POST /api/admin/services/:serviceId/permissions/:permissionId/deprecate`
     - `POST /api/admin/services/:serviceId/permissions/:permissionId/migrate`
     - `POST /api/admin/services/:serviceId/permissions/:permissionId/remove`
     - `POST /api/admin/services/:serviceId/clients`
     - `PATCH /api/admin/services/:serviceId/clients/:clientId`
     - `POST /api/admin/services/:serviceId/clients/:clientId/rotate-secret`
     - `POST /api/admin/services/:serviceId/credentials`
     - `PATCH /api/admin/services/:serviceId/credentials/:credentialId`
     - `PUT /api/admin/accounts/:accountId/services/:serviceId/permission`
     - `DELETE /api/admin/accounts/:accountId/services/:serviceId/permission`
   - 유지 대상 route:
     - account list/get/update status/reset password
     - service list/get
     - permission list
     - OIDC client list
     - service credential list/rotate/disable
     - permission dashboard list
     - service onboarding list/get/approve/reject
     - service applications list/approve/reject
   - 주의: domain service method는 service onboarding approval 내부에서 계속 사용되므로 무리하게 삭제하지 않는다.

8. visitor permission assignment를 lazy login 방식으로 변경한다.
   - `AccountsService.create()`에서 `grantVisitorForAllServices()` 호출을 제거한다.
   - 더 이상 필요한 외부 호출자가 없다면 `grantVisitorForAllServices()`는 제거하거나 private helper로 축소한다.
   - `ServiceRegistryService.create()`에서 모든 active account에 visitor assignment를 insert하는 로직을 제거한다.
   - service create/onboarding approval 경로는 `visitor` permission definition만 보장한다.
   - `AccountPermissionsService`에 `findActiveOrCreateVisitorForFirstLogin(accountId, serviceId)` 성격의 메서드를 추가한다.
   - 위 메서드는 active permission row가 있으면 그대로 반환한다.
   - row가 아예 없을 때만 active `visitor` permission definition을 찾아 assignment를 생성한다.
   - row가 존재하지만 status가 active가 아니면 `null` 또는 명시적 access-denied 결과를 반환해서 OIDC가 거부하도록 한다.
   - 동시 최초 로그인 race를 고려해 unique constraint 충돌 시 재조회하도록 처리한다.
   - `OidcController.authorize()`와 token/refresh의 permission 확인은 lazy helper를 사용한다.
   - `ServiceApplicationsService.createFromVisitorToken()`은 lazy login으로 발급된 visitor token을 전제로 동작해야 한다. 별도 bulk assignment에 의존하지 않도록 확인한다.
   - `AccountsService.searchForService()`의 visitor fallback은 검색 표시용일 뿐 DB row를 만들지 않는다는 점을 유지한다.
   - Account-Service Permission Dashboard는 실제 row만 표시한다.

9. tests를 업데이트한다.
   - 제거된 admin direct-write endpoints는 route 부재 또는 method unsupported를 확인한다.
   - service onboarding approve가 service/permission/OIDC client/service credential을 생성/수정하는 write path임을 확인한다.
   - credential rotate/disable이 계속 동작하는지 확인한다.
   - account disable/reset flow가 유지되는지 확인한다.
   - 기존 "서비스/계정 생성 시 visitor 권한 자동 부여" 테스트는 삭제하거나 "벌크 부여하지 않음"으로 기대값을 바꾼다.
   - 신규 계정이 기존 서비스에 첫 OIDC 로그인하면 visitor assignment가 생성되고 token claim에 visitor가 내려오는지 확인한다.
   - 신규 서비스 승인 후 기존 계정이 첫 OIDC 로그인하면 visitor assignment가 생성되는지 확인한다.
   - revoked/disabled account-service permission row는 첫 로그인 lazy grant로 복구되지 않고 access denied 되는지 확인한다.
   - bootstrap status가 required일 때 UI-level behavior는 가능하면 정적 HTML function 단위 또는 e2e smoke로 검증한다. 브라우저 테스트 인프라가 없으면 manual verification note를 남긴다.

10. docs/guide를 정리한다.
   - `CLAUDE.md` 또는 auth docs에 admin surface 원칙을 짧게 추가한다.
   - 새 서비스는 admin direct form이 아니라 service onboarding request를 제출해야 한다는 흐름을 명시한다.
   - 신규 서비스는 `visitor` role을 기본 role로 정의해야 하며, auth는 service login 시점에 필요한 account-service visitor assignment만 lazy 생성한다는 원칙을 명시한다.

## Acceptance Criteria
- `npm run lint` 통과.
- `npm run test` 통과.
- `npm run build` 통과.
- `npm run test:e2e` 통과.
- 로컬 실행은 Docker가 아니라 `npm run start:dev`로 확인한다.
- 테스트를 위해 직접 띄운 dev 프로세스는 작업 완료 후 정리한다.
- `/admin`에 직접 생성 폼들이 남아 있지 않다.
- `/admin`에 Service Onboarding Requests approve/reject UI가 있다.
- `Service Applications`가 service onboarding request와 혼동되지 않는 이름/설명을 가진다.
- OTP setup card에 QR + otpauth URI/secret fallback이 표시된다.
- 제거 대상 admin routes가 더 이상 직접 write entry로 동작하지 않는다.
- 회원가입 또는 service onboarding approval만으로 account-service visitor rows가 모든 조합에 벌크 생성되지 않는다.
- 첫 OIDC service login 시 필요한 service에 대해서만 visitor assignment가 생성된다.
- revoked/disabled assignment는 lazy visitor grant로 자동 복구되지 않는다.
- `auth-api-nest/.env.example`에 새 env가 필요하면 먼저 반영하고 최종 보고에 안내한다. 이번 계획상 새 env는 없어야 한다.

## Report Back To Orchestrator
- 제거한 admin route 목록과 유지한 route 목록.
- service onboarding approval에서 생성/수정되는 spec 범위.
- 새 dependency(`qrcode`) 추가 여부와 패키징 방식.
- visitor lazy assignment 구현 위치와 기존 bulk grant 제거 위치.
- UI manual verification 결과.
- 다른 서비스가 호출하던 admin direct-write API가 발견되면 영향을 받는 repo와 후속 조치.

## Decision Escalation
사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.
