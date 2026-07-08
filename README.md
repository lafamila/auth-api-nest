# auth-api-nest

Teddy 워크스페이스의 중앙 OIDC/OAuth2 인증 서버 — 계정/서비스/권한/OIDC client/service credential 관리와 내장 admin console 을 제공하며, 로그인이 필요한 모든 워크스페이스 서비스가 이 서버를 Provider 로 신뢰한다.

## 로컬 실행

```bash
npm install
npm run start:dev   # watch mode, http://localhost:3032
```

- 환경변수는 `.env.example` 을 복사해 `.env` 로 만든 뒤 채운다 (`DATABASE_URL`, `ISSUER_URL`, `COOKIE_SECRET`, `ADMIN_OTP_ENCRYPTION_KEY` 등).
- PostgreSQL 이 필요하다. 로컬은 워크스페이스 공유 infra PostgreSQL 을 auth 전용 DB 로 사용하는 것을 권장한다.
- DB 마이그레이션은 별도 스크립트 없이 `RUN_MIGRATIONS=true` 일 때 기동 시 자동 실행된다 (TypeORM `migrationsRun`).

## 빌드 / 테스트 / 린트

```bash
npm run build       # nest build → dist/
npm run lint        # ESLint
npm run test        # Jest unit tests (*.spec.ts)
npm run test:e2e    # Jest e2e (test/jest-e2e.json)
```

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

아키텍처, 통합 계약, admin/bootstrap 정책, 토큰/서명키 정책 등 상세 가이드는 [`CLAUDE.md`](./CLAUDE.md) 와 `docs/` (auth-flows, admin-api, service-integration) 를 참조.
