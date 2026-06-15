---
status: COMPLETED
summary: "admin bootstrap/session, service onboarding request, signup/email verification을 auth-api-nest에 구현한다"
completed_at: 2026-06-15
completion_reason: "auth-api-nest 구현, 빌드/lint/unit/e2e 검증, 커밋 완료."
---

# AUTH_BOOTSTRAP_AND_SERVICE_ONBOARDING — auth-api-nest execution plan

Canonical orchestration plan:

`../.idea/AUTH_BOOTSTRAP_AND_SERVICE_ONBOARDING_PLAN.md`

## Repo Responsibility

`auth-api-nest`는 이번 변경의 구현 주체다. 기존 `x-admin-key` 기반 admin UI/API를 superadmin session 기반으로 전환하고, 최초 superadmin bootstrap, Google OTP, 서비스 온보딩 요청/승인, 일반 회원가입과 이메일 인증을 제공한다.

다른 서비스 레포는 auth 구현 완료 후 일괄 업데이트할 예정이므로, 이 repo 작업 중 발견한 cross-repo 영향은 구현하지 말고 orchestrator에게 보고한다.

## Inputs / Dependencies

- Superadmin role은 기존 `accounts.is_super_admin`을 사용한다.
- Google OTP secret은 `ADMIN_OTP_ENCRYPTION_KEY` 환경변수로 AES-GCM 암호화해 저장한다.
- OTP secret/QR은 최초 bootstrap 과정에서만 일시 노출하고 저장 후 재조회하지 않는다.
- Admin session은 HttpOnly cookie, idle 30분, absolute 12시간, refresh token 없음.
- `x-admin-key`는 `/admin` UI와 `/api/admin/**` guard에서 제거한다.
- Service onboarding create/update request 제출 endpoint는 공개하되 rate limit과 중복 제한을 둔다.
- Update request는 최초 발급된 request secret으로 인증한다.
- 승인/거절은 superadmin session이 필요하다.
- 승인 또는 rotate 시 client/service credential raw secret은 1회만 응답한다.
- 일반 회원가입 이메일 인증번호는 알파벳+숫자 6자리, 5분 유효.
- 이메일 인증 rate limit은 email 기준 30분 내 5회, IP 기준 1시간당 10회.
- 일반 비밀번호 정책은 8자리 이상 및 특수문자 1개 이상.
- admin 강제 리셋값 `123456789`는 예외 허용하되, 다음 로그인 시 새 비밀번호 설정을 강제한다.

## Work Items

1. **Schema / Migration**
   - admin OTP secret 저장 필드 또는 별도 admin MFA entity를 추가한다.
   - admin session 저장 모델을 추가한다. idle/absolute 만료와 logout/revoke를 서버에서 통제할 수 있도록 DB-backed session으로 구현한다.
   - service onboarding request entity를 추가한다. 상태는 최소 `pending`, `approved`, `rejected`, `superseded`를 둔다.
   - request secret hash, requested spec JSON, approved snapshot JSON, decision metadata를 저장한다.
   - email verification entity를 추가한다. email, code hash, expiresAt, consumedAt, request IP, attempt count를 저장한다.
   - account에 reset-required 상태를 표현할 필드를 추가한다. 기존 status와 섞기보다 `password_reset_required` boolean을 우선 검토한다.

2. **Crypto / Validation Utilities**
   - AES-GCM encrypt/decrypt helper를 추가한다.
   - TOTP 생성/검증 helper를 추가한다.
   - QR image 또는 otpauth URI 생성 로직을 추가한다.
   - 비밀번호 정책 validator를 공통화한다.
   - 6자리 알파벳+숫자 이메일 인증 코드 generator와 hash 저장 로직을 추가한다.

3. **Admin Bootstrap API**
   - superadmin 존재 여부 API를 추가한다.
   - superadmin이 없을 때만 bootstrap start/verify/complete API를 허용한다.
   - OTP 검증까지 성공해야 account 생성을 완료한다.
   - bootstrap 중 이탈한 임시 상태가 완료된 superadmin으로 인식되지 않도록 한다.
   - superadmin이 하나라도 있으면 bootstrap API는 거부한다.

4. **Admin Login / Session**
   - admin login API를 추가한다.
   - ID/password 인증 후 `isSuperAdmin=true`, `status=active`, OTP 검증을 요구한다.
   - 성공 시 HttpOnly admin session cookie를 발급한다.
   - idle 30분, absolute 12시간 만료를 적용한다.
   - logout API를 추가한다.
   - session guard를 구현하고 `/api/admin/**`에 적용한다.

5. **Remove x-admin-key From Admin Surface**
   - `AdminGuard`를 `x-admin-key` 검사에서 superadmin session 검사로 교체한다.
   - admin console의 admin key 입력/저장 UI와 관련 client code를 제거한다.
   - docs에서 `x-admin-key`를 admin 운영 경로로 안내하지 않도록 수정한다.

6. **Service Onboarding Request API**
   - 공개 create request endpoint를 추가한다.
   - request payload 검증 DTO를 만든다: service key 후보, name, description, permission definitions, OIDC client specs, redirect URI, scopes, client type, PKCE, service credential scopes.
   - 중복 serviceKey/pending request/rate limit을 처리한다.
   - create response에서 update request용 raw request secret을 1회만 반환한다.
   - update request endpoint는 request secret을 검증하고 새 pending revision을 만든다.

7. **Service Onboarding Admin Review**
   - `/api/admin`에 request list/detail/approve/reject API를 추가한다.
   - approve 시 service registry, permission definitions, OIDC clients, service credentials를 생성 또는 수정한다.
   - approved core spec은 admin 직접 수정이 아니라 update request approve로만 변경되도록 기존 admin update endpoint와 UI를 조정한다.
   - emergency disable/archive, credential revoke/rotate, client disable은 유지한다.
   - approve response에서 새 raw secrets를 1회만 반환한다.

8. **Signup / Email Verification**
   - 회원가입 페이지/API를 추가한다.
   - signup start는 email 중복을 확인하고 인증 코드를 SMTP로 발송한다.
   - local/dev에서는 SMTP 미설정 시 console/log transport를 허용한다.
   - verify/complete는 5분 유효시간과 rate limit을 적용한다.
   - 완료 시 account 생성 및 모든 active service의 `visitor` 권한 부여를 수행한다.

9. **Password Reset Required Flow**
   - admin reset password 기본값 `123456789`를 허용한다.
   - reset된 계정은 `password_reset_required` 상태로 표시한다.
   - 해당 계정이 일반 로그인하면 새 비밀번호 설정을 완료해야 OIDC authorize/token 흐름을 진행할 수 있게 한다.
   - 새 비밀번호는 일반 정책을 만족해야 한다.

10. **Admin Console UI**
    - `/admin` 진입 시 bootstrap status에 따라 bootstrap 화면 또는 login 화면으로 분기한다.
    - bootstrap 화면에 OTP otpauth URI 또는 QR 이미지를 보여준다.
    - admin login 화면은 ID/password/OTP를 받는다.
    - 로그인 후 기존 admin 기능은 session으로 API 호출한다.
    - service onboarding request 목록/상세/approve/reject 화면을 추가한다.
    - signup 페이지는 admin console과 분리된 일반 페이지로 제공한다.

11. **Docs / CLAUDE**
    - `docs/admin-api.md`, `docs/service-integration.md`, `docs/auth-flows.md`를 새 흐름에 맞게 업데이트한다.
    - `CLAUDE.md`에 admin bootstrap, service onboarding request, signup/email verification, x-admin-key 제거 원칙을 기록한다.

12. **Tests**
    - unit tests: password policy, OTP helper, encryption helper, service request validation.
    - e2e tests: bootstrap, admin login/session guard, service onboarding approve/reject, signup/email verification, reset-required login.
    - 기존 e2e가 `x-admin-key`에 의존하면 superadmin session setup helper로 교체한다.

## Acceptance Criteria

- `npm run build` 통과.
- 관련 unit/e2e 테스트 통과.
- DB에 superadmin이 없으면 `/admin`이 bootstrap 흐름으로 진입한다.
- OTP 검증 완료 전에는 superadmin 계정 생성이 완료되지 않는다.
- DB에 superadmin이 있으면 `/admin`이 admin login 흐름으로 진입한다.
- 일반 계정은 admin login 불가.
- superadmin ID/password + OTP 성공 시 HttpOnly admin session이 발급된다.
- session 없는 `/api/admin/**` 요청은 거부된다.
- `/admin` UI와 `/api/admin/**` guard가 더 이상 `x-admin-key`에 의존하지 않는다.
- service onboarding request create/update/approve/reject가 동작한다.
- approved core spec은 admin 직접 수정이 아니라 update request 승인으로만 바뀐다.
- raw client/service credential secret은 생성/승인/rotate 시점에만 1회 표시된다.
- signup은 email verification 없이는 완료되지 않는다.
- 이메일 인증번호는 5분 만료, email/IP rate limit이 적용된다.
- 신규 가입자는 모든 active service에 `visitor`를 받는다.
- admin reset `123456789` 로그인은 새 비밀번호 설정을 강제한다.
- 문서와 `CLAUDE.md`가 구현 흐름과 일치한다.

## Report Back To Orchestrator

- consuming service가 바꿔야 하는 env var, API endpoint, client registration flow.
- 기존 `x-admin-key`를 쓰던 테스트/문서/서비스 호출이 남아 있으면 파일 경로와 변경 필요사항.
- service onboarding request 승인 결과로 서비스가 저장해야 하는 값 목록.
- 기존 DB 마이그레이션 중 수동 정리가 필요한 데이터.
- 이메일 SMTP 설정에 필요한 배포 env var 목록.

## Decision Escalation

사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.
