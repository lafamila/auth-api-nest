---
status: COMPLETED
summary: "Admin Session UX 를 정리하고 서비스 요청 작성 화면을 /service 로 분리한다."
completed_at: 2026-06-15
completion_reason: "admin session/service page split 구현과 lint/build/unit/e2e 및 local smoke 검증이 완료됨."
---

# AUTH_ADMIN_SESSION_AND_SERVICE_PAGE — auth-api-nest execution plan

Canonical orchestration plan:

`../../.idea/AUTH_ADMIN_SESSION_AND_SERVICE_PAGE_PLAN.md`

## Repo Responsibility
`auth-api-nest` 는 admin session/bootstrap/login/logout UX 를 정리하고, service onboarding request 작성 UI 를 `/admin` 에서 `/service` 로 분리한다. Backend 는 bootstrap complete 직후 admin session cookie 를 발행해야 한다.

## Inputs / Dependencies
- Root plan: `../../.idea/AUTH_ADMIN_SESSION_AND_SERVICE_PAGE_PLAN.md`
- Current admin UI: `public/index.html`
- New service page target: `public/service.html`
- Admin auth service/controller:
  - `src/admin/admin-auth.service.ts`
  - `src/admin/controllers/admin-auth.controller.ts`
- Static/page routing:
  - `src/app.module.ts`
  - or new controller under `src/admin` / app-level page controller
- Tests:
  - `test/app-bootstrap.e2e-spec.ts`
- Docs:
  - `docs/admin-api.md`
  - `docs/service-integration.md`

## Work Items
1. Backend bootstrap complete session 발행
   - `AdminAuthService.login()` 의 session creation/cookie code 를 private helper 로 추출한다.
   - `completeBootstrap()` 이 `request`, `response` 를 받아 account 생성 후 helper 로 admin session 을 생성하고 cookie 를 set 하게 한다.
   - `AdminAuthController.completeBootstrap()` 에 `@Req()` 와 passthrough `@Res()` 를 추가한다.
   - bootstrap complete response 는 login response 와 같은 형태로 `account`, `idleExpiresAt`, `absoluteExpiresAt` 을 포함해야 한다.

2. `/admin` UI 에서 service request builder 제거
   - `public/index.html` 에서 `Create Service Onboarding Request` section 제거.
   - builder-only state/functions/events 제거:
     - service request draft/result
     - dynamic permission/client/credential row rendering
     - JSON preview builder
     - submit handler for `/api/service-onboarding-requests`
   - `/admin` 은 approval/reject/read/credential rotate 같은 admin action 만 남긴다.

3. `/service` UI 추가
   - `public/service.html` 생성.
   - 기존 request builder 기능을 `/service` 로 옮긴다.
   - `/service` 에서 session 이 없으면 request form 을 숨긴다.
   - `/service` 에서 login/bootstrap 완료 후 request form 을 보여준다.
   - `/service` 에서 submit 성공 시 request id/status/revision/request-update-only `requestSecret` 을 보여준다.

4. `/service` route 추가
   - `GET /service` 가 `public/service.html` 을 반환하게 한다.
   - 구현 방식은 controller `sendFile()` 을 우선한다. `ServeStaticModule` 을 복잡하게 중복 구성할 필요가 없다.
   - 기존 `/admin` serving 은 깨지지 않아야 한다.

5. Admin Session button UX 공통 적용
   - 로그인 전: floating button label `Admin Session`, 클릭 시 access panel 표시.
   - bootstrap 필요: panel 에 bootstrap form 표시.
   - superadmin 존재: panel 에 login form 표시.
   - 로그인 후: floating button label `Logout`, 클릭 시 바로 `/api/admin/logout` 호출.
   - 로그인 후 panel 내부 logout form/button 은 제거한다.
   - `/admin` 과 `/service` 모두 동일 UX 를 따른다.
   - bootstrap complete 성공 후 자동 session 상태로 전환한다.

6. One-time secret modal 닫힘 보정
   - `/admin` operational secret modal 하단에 확인 버튼 추가.
   - 상단 close 버튼과 하단 확인 버튼만 modal 을 닫는다.
   - overlay click handler 로 secret modal 을 닫지 않는다.
   - copy button click 은 값만 clipboard 에 복사하고 modal 을 닫지 않는다.
   - modal close 시 raw secret state 를 제거한다.

7. 문서 업데이트
   - `docs/admin-api.md` 에 다음을 기록:
     - bootstrap complete 가 admin session cookie 를 발행함
     - `/admin` 은 admin review/operation console
     - `/service` 는 service onboarding request 작성 화면
     - 로그인 후 Admin Session button 이 Logout 으로 동작함
   - `docs/service-integration.md` 에 `/service` 요청 작성 UI 와 future developer 확장 의도를 기록한다.

8. 테스트 업데이트
   - `test/app-bootstrap.e2e-spec.ts` 를 갱신한다.
   - Admin UI surface:
     - `public/index.html` 에 `Create Service Onboarding Request` 가 없어야 한다.
     - `Service Onboarding Requests`, `Account Access Requests` 는 있어야 한다.
     - panel 내부 logout button/form 이 없어야 한다.
   - Service UI surface:
     - `public/service.html` 에 `Create Service Onboarding Request`, `JSON Preview`, `Request-update-only secret` 이 있어야 한다.
   - Route smoke:
     - `GET /service` 가 service page HTML 을 반환해야 한다.
   - Bootstrap complete:
     - complete response 에 Set-Cookie 가 있고, 해당 cookie 로 `/api/admin/session` 이 성공해야 한다.
   - Secret modal:
     - 하단 확인 버튼이 존재해야 한다.
     - overlay click close 로직이 없어야 한다.

9. 검증 실행
   - `npm run lint`
   - `npm run build`
   - `npm run test`
   - `npm run test:e2e`
   - 가능하면 local `npm run start` 또는 `node dist/main` 으로 `/admin`, `/service` smoke 를 확인한다. 이미 떠 있던 프로세스는 종료하지 않는다.

10. 커밋
   - 통과하면 기능 단위 commit 을 만든다.
   - Co-authored-by trailer 는 넣지 않는다.
   - Lore commit protocol 을 따른다.

## Acceptance Criteria
- Bootstrap UI 는 active superadmin 0명일 때만 표시된다.
- active superadmin 이 있으면 login form 만 표시된다.
- Bootstrap complete 성공 시 admin session cookie 가 발행되고 자동 로그인 상태가 된다.
- 로그인 완료 후 floating button 이 `Logout` 으로 바뀌며 클릭 즉시 logout 된다.
- panel 내부 별도 logout button/form 이 없다.
- `/admin` 에 `Create Service Onboarding Request` 가 없다.
- `/service` 에 request builder 가 있고 login session 이 필요하다.
- `/service` 는 기존 public service onboarding request API 로 pending request 를 만든다.
- one-time operational secret modal 은 close/확인 버튼으로만 닫힌다.
- docs 가 변경된 운영 흐름을 설명한다.
- lint/build/unit/e2e 검증이 통과한다.

## Report Back To Orchestrator
- Bootstrap complete session 발행을 backend helper 로 구현했는지 보고한다.
- `/service` route 구현 방식과 파일 분리 방식을 보고한다.
- 새 env/migration 이 생겼다면 보고한다. 현재 계획상 없어야 한다.
- browser smoke 를 못 했다면 그 이유와 남은 위험을 보고한다.

## Decision Escalation
사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.
