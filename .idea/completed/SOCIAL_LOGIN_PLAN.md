---
status: COMPLETED
completed_at: 2026-11-04
completion_reason: "Google/Kakao/Naver 로그인·계정 연결·선택 ID/PW 구현, 공식 등록 가이드와 Todo/Chat 연동 보정 및 로컬 검증 완료. 실제 제공자 키/검수/운영 배포는 운영자 준비사항."
summary: "Google·Kakao·Naver 소셜 로그인, 검증된 이메일 기반 다중 소셜 연동과 선택적 로컬 ID/PW 가입을 중앙 Auth에 추가한다."
---

# Social Login

Canonical root plan: `../../../.idea/completed/AUTH_SOCIAL_LOGIN_PLAN.md`.

## 현재 기준과 사용자 결정

- 시작 기준: main `a2905bc`, clean worktree, 기존 hosted-login navigation 수정 유지.
- 소셜 로그인은 기존 중앙 OIDC 로그인 화면에 통합한다. 각 서비스의 callback/state/PKCE/nonce와 계정 UUID 및 권한은 바꾸지 않는다.
- 같은 검증된 이메일이면 기존 계정에 소셜 identity를 자동 연결한다. 이미 연결한 identity의 재로그인은 이메일이 아니라 제공자/클라이언트/subject로 식별한다.
- Google의 외부 이메일, Naver 등 소유 검증이 부족한 경우 추가 이메일 인증을 한다. 제공자 이메일 없음도 직접 입력 후 인증하며, 검증 없이 자동 병합하지 않는다. 사용자 승인: 2026-11-04.
- 신규 계정은 선택 ID를 비우면 실제 login_id/password_hash 모두 NULL인 소셜 전용 계정이다. ID를 넣으면 중복 확인과 비밀번호/확인을 함께 요구한다. 사용자 승인: 2026-11-04.
- 계정 하나에 여러 제공자를 연결한다. provider 이름을 DB enum으로 제한하지 않는다. 외부 provider 토큰은 계정/로그/브라우저에 저장하지 않는다.
- 관리자 로그인/OTP 정책을 우회하지 않으며 disabled/locked 계정, 서비스 revoke, 기존 password-reset 정책을 보존한다.

## 구현

1. 공식 최신 문서 확인: Google 서버 OAuth+UserInfo, Kakao REST, Naver OAuth+프로필. 제공자별 endpoint/scope/이메일 검증 기준과 설정 절차를 문서화한다.
2. Additive migration: nullable local credentials + pair invariant; social identities; 단기 DB-persisted browser-bound transactions. 기존 사용자 데이터는 변경/삭제하지 않는다.
3. 제공자 registry와 adapters: code exchange, Google PKCE, state/provider/client binding, timeout, bounded response, sanitized errors.
4. hosted transaction에서 소셜로 시작: 기존 strict-cookie binding 검증 후 canonical 요청을 저장. provider callback은 별도 Lax HttpOnly signed cookie로 바인딩하고 state를 단회 사용한다.
5. account linking/creation은 트랜잭션, provider-subject unique 제약과 normalized email serialization으로 경쟁 조건을 처리한다. 이미 연결된 identity가 다른 이메일을 반환해도 다른 계정으로 이동하지 않는다.
6. 신규 소셜 가입/이메일 추가 인증 화면: 선택 ID 및 중복 확인, 조건부 PW/확인, 기존 UI 규칙·모바일 16px 입력·loading/error 처리.
7. 기존 admin/search/claims의 credentialless 계정 호환. preferred_username은 ID가 없으면 표시용 이메일을 사용하며 로컬 로그인 ID를 생성하지 않는다.
8. `.env.example`, canonical guides, README와 제공자별 상세 가입/앱 등록/키 발급/심사/배포 문서를 갱신한다. 실제 운영 키 발급/등록은 사용자가 수행한다.

## 검증 기준

- Google/Kakao/Naver adapter URL·필드·검증 기준·오류·timeout unit tests.
- 신규 소셜 전용/선택 ID+PW, ID 경쟁, 자동 이메일 연동, 다중 제공자, 이미 연결된 identity의 이메일 변경, disabled/locked 계정 테스트.
- CSRF/state/provider/client/cookie mismatch, replay, transaction expiry, 동시 callback/complete, OTP rate limit·expiry·실패 횟수 테스트.
- OIDC 서비스 복귀, native custom-scheme, select_account SSO 보존, nonce/PKCE, 기존 로그인/signup/admin/notification/webhook 회귀 테스트.
- 빈 DB와 기존 DB fixture에 실제 migration 실행. 로컬 실사용 DB/운영 DB는 변경하지 않는다.
- lint/typecheck/build/unit/e2e 및 브라우저 HTTP fixture 기반 signup/중복확인/이메일 인증/콜백 이동 검증. 실 provider smoke는 사용자 발급 credential 없이는 검증 불가임을 명시한다.
- 완료 판정은 위 요구사항 전체를 기준으로 한다. 키 미설정 기본 상태에서는 기존 로그인 UI/동작을 유지한다.

## 구현 및 검증 결과

- Auth unit 394개, 전체 e2e 100개(실제 migration/롤백 동시성 포함), lint/typecheck/build/format 통과.
- Todo session/mode 회귀 63개 및 39 subtests 통과, session-auth 19개 재실행 통과.
- Chat 전체 46개(PostgreSQL 및 전용 Redis prefix 통합 포함) 통과.
- 실제 Nest + 외부 provider/mail fixture로 Google 선택 ID/PW, Naver OTP+ID 생략,
  Kakao ID 생략 가입을 브라우저에서 완료하고 실제 코드 교환 후 서비스 복귀 확인.
  Desktop/mobile 390px overflow 없음, 입력 font 16px, 공식 버튼 assets 로딩 확인.
- 로컬 auth DB는 `.backups/db/auth-before-social-20261104-2318.sql`로 백업 후
  신규 migration 두 개만 적용. 기존 accounts/services/clients/permission definitions/
  assignments row fingerprint 동일(10/8/8/31/15행). 테스트 계정은 격리 DB에만 생성.
- 사용자 승인으로 로컬 개발 Auth 컨테이너만 재시작하여 healthy 및 신규 provider API 확인.
  운영 DB/실서버/다른 사용자 서비스는 변경하지 않음. 제공자 키는 로컬 .env에도 빈 값으로만 추가.
- 실제 Google/Kakao/Naver 키 발급·권한 심사·실계정 로그인은 수행하지 않았다.
  `docs/social-login.md`에 제공자별 단계와 배포 순서를 기록했다.
