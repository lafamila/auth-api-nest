# auth-api-nest

Teddy 워크스페이스의 중앙 OIDC/OAuth2 인증 서버 — 계정/서비스/권한/OIDC client/service credential 관리, 중앙 Notification control/data plane, 내장 admin console 을 제공하며 로그인이 필요한 모든 워크스페이스 서비스가 이 서버를 Provider 로 신뢰한다.

## 로컬 실행

```bash
npm install
npm run start:dev   # watch mode, http://localhost:3032
```

- 환경변수는 `.env.example` 을 복사해 `.env` 로 만든 뒤 채운다 (`DATABASE_URL`, `ISSUER_URL`, `COOKIE_SECRET`, `ADMIN_OTP_ENCRYPTION_KEY` 등).
- PostgreSQL 이 필요하다. 로컬은 워크스페이스 공유 infra PostgreSQL 을 auth 전용 DB 로 사용하는 것을 권장한다.
- DB 마이그레이션은 별도 스크립트 없이 `RUN_MIGRATIONS=true` 일 때 기동 시 자동 실행된다 (TypeORM `migrationsRun`).
- `/service` onboarding form 은 같은 validation 경로로 JSON 파일, drag-and-drop, 붙여넣기 import 를 지원한다.
- `/` → `/login`에서 로그인한다. 일반 계정은 본인 서비스/등급·내 정보, superadmin은 Google OTP 확인 후 관리 콘솔을 본다. `/admin` UI는 제거되었고 `/service`는 admin session 없으면 404다.
- 이번 버전은 `AddAccountCredentialVersion20261116000000` migration이 필요하다. 기존 계정/권한은 유지한다. [포털 계약](./docs/account-portal.md)을 참고한다.

## 빌드 / 테스트 / 린트

```bash
npm run build       # nest build → dist/
npm run lint        # ESLint
npm run format:check # Prettier verification
npm run test        # Jest unit tests (*.spec.ts)
npm run test:e2e    # Jest e2e (test/jest-e2e.json)
```

e2e는 `TEST_DATABASE_URL`에 **격리된 테스트 DB**를 지정해서 실행한다. 기존 bootstrap
fixture는 계정/admin 데이터를 변경하므로 운영/실사용 DB를 연결하지 않는다.

## Docker

```bash
docker build -t auth-api-nest .
# repo-local smoke 환경 (PostgreSQL 포함, 워크스페이스 root infra compose 와 별개)
docker compose -f docker-compose.dev.yml up --build
```

## Healthcheck

- `GET /health` → `{ "status": "ok" }` (global prefix 없음 — 이 레포는 `/api` prefix 를 쓰지 않는다).
- Dockerfile 자체에는 `HEALTHCHECK` instruction 이 없으므로 배포 환경에서는 `GET /health` 를 외부 헬스체크로 사용한다.

## 상세

Google·Kakao·Naver 소셜 로그인과 선택 ID/PW 가입을 지원한다. 제공자 키는 Auth에만 설정하며,
설정되지 않은 제공자는 표시하지 않는다. 기존 계정의 검증된 이메일은 같은 UUID에 연결한다.
제공자 가입·앱 등록·이메일 동의·검수·키 발급·callback·배포 순서는
[`소셜 로그인 등록 가이드`](./docs/social-login.md)를 따른다. 소셜 전용 계정 호환성을 위해
Chat 업데이트를 먼저 배포하고 Auth의 새 migration 두 개를 적용한다.

Notification API/FCM/retention/onboarding 계약은 [`docs/notifications.md`](./docs/notifications.md)를 참조한다. 전체 아키텍처, admin/bootstrap 정책, 토큰/서명키 정책 등은 [`CLAUDE.md`](./CLAUDE.md) 와 `docs/` (auth-flows, admin-api, service-integration, permission-webhooks, account-directory) 를 참조.
