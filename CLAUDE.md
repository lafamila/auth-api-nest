# auth-api-nest

운영급 중앙 OIDC/OAuth2 provider (NestJS). 워크스페이스의 로그인/권한이 필요한 모든 서비스(todo, game-platform, body-lab 등)가 이 서버를 OIDC Provider 로 신뢰한다. 계정/서비스/권한/OIDC client/service credential 관리, service onboarding request, 내장 admin console, e2e 스펙과 `docs/` 통합 문서를 갖춘 구현 완료 서비스다. 최초 설계 결정 문서는 `.idea/completed/oauth-blueprint.md` 참조 (일부 초기 결정은 이후 bootstrap/email-verified signup 정책으로 대체됨 — 현행 계약은 이 파일과 `docs/` 가 canonical).

> 이 파일이 본 레포의 canonical 가이드입니다. `AGENTS.md` 는 codex 호환용 stub 입니다.

- **Lifecycle**: DEPLOY
- **Status**: active
- **Port**: 3032
- **Auth**: provider — 이 서비스가 중앙 OIDC 제공자

## 워크스페이스 대원칙 (canonical)

이 레포는 `../CLAUDE.md` 의 **DEVELOPMENT PRINCIPLES** 섹션을 따른다. 핵심 재진술:

1. **인증** — 본 레포가 *중앙 인증 서버* 자체. 다른 서비스가 이 레포를 OIDC Provider 로 신뢰한다. `.idea/completed/oauth-blueprint.md` 의 결정(NestJS + oidc-provider + PostgreSQL, issuer `https://auth.lafamila.xyz`)을 따른다.
2. **기능 단위 커밋** — 한 기능이 계획-구현-검토를 통과하면 즉시 1개의 커밋. 여러 기능을 묶지 않는다.
3. **Agent co-author 제외** — Codex, Claude, OmX 등 agent/tool 저자를 `Co-authored-by` trailer 로 추가하지 않는다. 사용자가 명시적으로 요청한 경우만 예외.
4. **계획 → 구현 → 검토** — 계획 단계에서 검토 통과 기준(어떤 테스트/명령이 통과해야 "done"인지)을 명시한다. auth 관련 변경은 *반드시* 머지 전 테스트.
5. **Docker 빌드 가능** — 독립 운영 배포 서비스다. Dockerfile 과 `.env.example` 를 이 레포의 배포 기준으로 유지하며, 루트 `docker-compose.yml` 앱 등록을 전제하지 않는다. issuer 도메인은 `https://auth.lafamila.xyz`.
6. **서비스 통합 계약 유지** — 이 레포는 다른 서비스들이 참고하는 중앙 auth 계약의 소유자다. OIDC/OAuth2 endpoints, callback/redirect URI 검증, token claim, service permission claim, admin service/client/permission/credential API, service credential scope 정책을 바꿀 때는 consuming service 영향까지 검토한다.
7. **신규 서비스 onboarding 지원** — admin console 과 문서는 새 서비스가 준비해야 할 항목을 계속 설명할 수 있어야 한다: `serviceKey`, permission definitions, OIDC client, redirect/callback URI, login/session/token 처리, access denied 정책, backend-to-auth service credential, env var, secret 비노출 원칙.
8. **Service onboarding request 우선** — 새 서비스 등록과 기존 서비스 spec 변경은 service onboarding request 를 통해 진행한다. 서비스가 제출한 approved core spec(`serviceKey`, permission keys, redirect URIs, scopes, client type, PKCE, service credential scopes)은 auth admin 이 임의 수정하지 않는다. 수정이 필요하면 서비스가 update request 를 제출하고 superadmin 이 승인/거절한다. 운영상 disable/archive, credential revoke/rotate, client disable 은 admin 조치로 허용한다.
9. **Admin access 는 superadmin session 기반** — `/admin` UI 와 `/api/admin/**` 는 `x-admin-key` 가 아니라 `accounts.is_super_admin` 계정의 admin session 으로 보호한다. Superadmin 이 없을 때만 bootstrap 을 열고, Google OTP 등록/검증까지 완료되어야 superadmin 생성이 완료된다. OTP 기기 분실 등 복구는 DB 에서 해당 superadmin 을 직접 삭제하고 bootstrap 을 다시 여는 방식으로 처리한다.
10. **Secret one-time exposure** — OTP secret, OIDC client secret, service credential secret, request secret 등 raw secret 은 생성/승인/rotate 과정에서 한 번만 보여준다. 저장 후 재조회 가능한 API/UI 를 만들지 않는다. 브라우저에 노출되는 secret 은 사용자가 직접 등록/저장해야 하는 bootstrap 또는 approval completion 순간으로 제한한다.
11. **Signup and email verification** — 일반 회원가입은 email 인증을 요구한다. 인증번호는 알파벳+숫자 6자리, 5분 유효, email 기준 30분 내 5회 및 IP 기준 1시간 10회 제한을 따른다. 신규 계정은 account row 만 생성되고, 특정 서비스에 최초 로그인할 때 해당 account-service row 가 전혀 없으면 그 시점에만 `visitor` 가 lazy 생성된다. revoked/disabled/suspended row 는 자동 복구하지 않는다.
12. **Cross-repo 영향 보고** — 이 레포의 변경이 다른 repo, 공통 API 계약, auth claim/permission, env var, Docker/deploy 설정, 공통 문서에 영향을 준다고 판단되면 현재 orchestrator 에게 반드시 보고한다. 직접 보고할 수 없으면 워크스페이스 루트 `../.idea/` 에 `{REPO_NAME}_CROSS_REPO_IMPACT_{YYYYMMDD}.md` 형식의 handoff 문서를 남긴다.
13. **사용자 결정 필요사항 에스컬레이션** — 사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않고 작업을 중단한 뒤 현재 orchestrator 에게 전달하여 결정받고 진행한다. orchestrator 에 보고할 수 없으면 workspace root `../.idea/` 에 handoff 문서를 남긴다.

## Feature Workflow (대원칙 #3 의 이 레포 적용)

1. `.idea/` 또는 신규 계획 문서에서 기능을 선택
2. 계획서 작성 — 변경 파일, 인터페이스, **검토 통과 기준** 명시 (unit tests, e2e coverage, migration checks, OIDC conformance 등)
3. 구현
4. 통과 기준 만족 여부 직접 실행/테스트
5. 통과 시 1개의 커밋으로 마무리

## Project Structure & Module Organization

- `src/` for NestJS modules, controllers, services, guards, adapters (`oidc/`, `admin/`, `signup/`, `database/`, `config/`, `domain/`, `internal/`, `common/`, `health.controller.ts` 등).
- `src/database/` for PostgreSQL persistence and migrations (`RUN_MIGRATIONS=true` 시 기동 시 실행).
- `test/` for e2e tests; colocate unit tests as `*.spec.ts`.
- `docs/` for integration docs (`auth-flows.md`, `admin-api.md`, `service-integration.md`).
- `.idea/` for design/decision documents (최초 blueprint 는 `.idea/completed/oauth-blueprint.md`).
- `.omx/` is local agent/runtime state and must remain untracked.

## Build, Test, and Development Commands

Use local app execution commands separately from independent deployment checks:

- `npm install`: install dependencies.
- `npm run start:dev`: run the local server in watch mode.
- `npm run build`: compile TypeScript into `dist/` for local and containerized runs.
- `npm run lint`: run ESLint.
- `npm run test`: run unit tests.
- `npm run test:e2e`: run integration/OIDC flow tests.
- `docker build -t auth-api-nest .`: build the independent deployment image from this repo.
- `docker compose -f docker-compose.dev.yml up --build`: run a repo-local Docker smoke environment when needed. This is separate from the workspace root infra compose and may use a repo-local PostgreSQL container for convenience only.

Prefer a shared PostgreSQL infra endpoint with an auth-specific database/schema/role instead of assuming a dedicated auth PostgreSQL container. For local development, `DATABASE_URL` can point at the shared workspace/root infra PostgreSQL; the repo-local compose PostgreSQL is only a smoke-test fallback. For deployed environments, supply the service's own runtime `.env` values and managed shared-PostgreSQL connection details.

Document database setup commands, such as `npm run migration:run`, when added.

## Coding Style & Naming Conventions

Use TypeScript with NestJS conventions. Name files with standard suffixes: `auth.module.ts`, `accounts.service.ts`, `admin.controller.ts`. Keep modules aligned to domain boundaries: accounts, services, OIDC clients, permissions, audit logs, token storage.

Use two-space indentation, explicit DTOs, and validation decorators. Run formatting and linting before commits.

## Testing Guidelines

Use Jest. Name unit tests `*.spec.ts` and e2e tests `*.e2e-spec.ts`. Prioritize authorization code + PKCE, refresh tokens, permissions, audit logging, and admin-only operations.

## Commit & Pull Request Guidelines

There is no commit history yet. Use concise, imperative subjects explaining why the change exists, for example `Add OIDC client registry model`. Include verification notes for protocol, database, or security-sensitive changes.

Pull requests should include a summary, linked issue or decision note, test results, migration notes, and admin console screenshots.

## Feature Documentation

When a feature is completed, create or update developer documentation so other APIs or services can integrate with it. Document endpoints, DTOs, auth requirements, permission keys, events, variables, and example calls. Use `docs/auth-flows.md` or `docs/admin-api.md`.

## Service Integration Contract

Auth-facing changes must preserve or explicitly version the contract that other services use.

Every service integration should be describable with:

- stable `serviceKey`
- service-specific permission definitions / 권한등급
- whether it needs an OIDC client
- allowed redirect/callback URI values
- login start and callback/session flow
- token validation requirements: issuer, audience, signature, expiry, service permission claim
- permission-level branching expected inside the service
- access denied behavior owned by the service
- backend-to-auth service credential need and exact scopes
- local/prod env vars
- secret handling rules: client secrets and service credential secrets must never be exposed to browser/frontend code

New or changed services should submit these values through the service onboarding request API instead of assuming the auth admin will type them directly into the admin console. The approved request becomes the canonical auth-side spec for that service. Core spec changes require a new update request from the service; auth admin may approve/reject the change but should not silently edit the service contract.

When auth APIs, claims, admin console flows, or credential scope semantics change, update docs and report affected repos before finishing the feature.

## Admin Bootstrap & Signup Contract

- If no active superadmin exists, `/admin` shows bootstrap and allows creating the first superadmin only after Google OTP registration and verification are complete.
- If an active superadmin exists, `/admin` shows superadmin login. General accounts cannot log into admin.
- Admin session uses HttpOnly cookies with idle 30 minutes and absolute 12 hours. There is no admin refresh token.
- `x-admin-key` is not the admin authorization model. Do not add new admin UI/API paths that depend on it.
- OTP secrets are encrypted at rest using `ADMIN_OTP_ENCRYPTION_KEY` and exposed only during initial registration.
- General signup requires email verification. Signup-created accounts do not receive eager account-service rows; `visitor` is created lazily on first login to an active service only when no row exists yet.
- Normal passwords require at least 8 characters and at least one special character. Admin reset value `123456789` is a forced temporary password and must set a reset-required state so the user changes it after login.

## Token Lifecycle & Signing Keys

Phase 1 게임 플랫폼 세션 안정화 작업으로 확정된 토큰/서명키 정책:

- **서명키 DB 영속화** — RS256 서명키는 최초 1회 생성 후 `signing_keys` 테이블에 저장한다. private key 는 `ADMIN_OTP_ENCRYPTION_KEY` 로 at-rest 암호화(AesGcmService 재사용, 신규 env 키 없음). auth 재시작 후에도 동일 `kid` 를 로드하므로 재시작 전에 발급된 access token 이 계속 검증된다.
- **JWKS 다중 키** — `GET /oauth/jwks` 는 active 키 + retiring 키를 함께 노출한다. access token 검증은 JWT 헤더 `kid` 기반. 소비 서비스는 JWKS 를 `kid` 로 캐시하고 미지의 `kid` 는 refetch 한다(현행 jose `createRemoteJWKSet` 소비자는 자동 처리).
- **토큰 TTL env 설정화 + per-client override** — `ACCESS_TOKEN_TTL_SECONDS`(기본 900), `REFRESH_TOKEN_TTL_SECONDS`(기본 604800). OIDC client 는 `oidc_clients.access_token_ttl_seconds` / `refresh_token_ttl_seconds`(nullable)로 값을 재정의할 수 있다. 발급 시 우선순위: **client override → env → 코드 기본값**. per-client 값은 service onboarding request/update 스펙(`accessTokenTtlSeconds` / `refreshTokenTtlSeconds`)으로만 신청한다(원칙 8 — auth admin 임의 수정 금지).
- **Refresh rotation grace** — `REFRESH_ROTATION_GRACE_SECONDS`(기본 60). 이미 rotate 된 refresh token 을 grace 이내 재제시하면 family 폐기 대신 새 rotation 1회를 허용한다(크래시-재시도 대비). grace 초과 재사용은 기존대로 family 전체 revoke + 401. hash 만 저장하므로 동일 successor 원문을 재반환하지는 않는다.
- **Revocation 정합성** — 계정 disable / 비밀번호 reset 시 해당 계정 refresh family 전체를 revoke 한다. refresh grant 는 token 소비 전에 `account.status` 를 검사해 비활성 계정을 `403 access_denied` 로 거절한다.
- **Authorization code 영속화** — auth code 는 in-memory 가 아니라 `token_records`(type=`authorization_code`)에 저장하고 consume 시 DELETE(단일 사용). 재시작 순간에 진행 중이던 로그인도 완료된다. 만료된 `token_records` row 는 기동 시 + refresh 시(throttled) best-effort 로 정리한다.

신규 env 키(배포 env 반영 필요): `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_SECONDS`, `REFRESH_ROTATION_GRACE_SECONDS`. 모두 기본값이 현행 동작과 동일하므로 미설정 시 무변경. 서명키 암호화는 기존 `ADMIN_OTP_ENCRYPTION_KEY` 를 재사용한다.

## Security & Configuration Tips

Never commit secrets, private keys, database URLs, or runtime state. Keep issuer, client secrets, cookie settings, and PostgreSQL credentials in environment variables. Auth changes require tests before merge.

The RS256 signing private key is now stored in `signing_keys` encrypted at rest with `ADMIN_OTP_ENCRYPTION_KEY`. Keep that key stable across restarts and deployments: rotating it makes existing stored signing keys undecodable (a new key is generated instead), and it also invalidates admin OTP secrets.
