# auth-api-nest

Planning-stage NestJS authentication service for the workspace-wide OIDC/OAuth2 provider. Decisions live in `.idea/oauth-blueprint.md`.

> 이 파일이 본 레포의 canonical 가이드입니다. `AGENTS.md` 는 codex 호환용 stub 입니다.

## 워크스페이스 대원칙 (canonical)

이 레포는 `../CLAUDE.md` 의 **DEVELOPMENT PRINCIPLES** 섹션을 따른다. 핵심 재진술:

1. **인증** — 본 레포가 *중앙 인증 서버* 자체. 다른 서비스가 이 레포를 OIDC Provider 로 신뢰한다. `.idea/oauth-blueprint.md` 의 결정(NestJS + oidc-provider + PostgreSQL, issuer `https://auth.lafamila.xyz`)을 따른다.
2. **기능 단위 커밋** — 한 기능이 계획-구현-검토를 통과하면 즉시 1개의 커밋. 여러 기능을 묶지 않는다.
3. **Agent co-author 제외** — Codex, Claude, OmX 등 agent/tool 저자를 `Co-authored-by` trailer 로 추가하지 않는다. 사용자가 명시적으로 요청한 경우만 예외.
4. **계획 → 구현 → 검토** — 계획 단계에서 검토 통과 기준(어떤 테스트/명령이 통과해야 "done"인지)을 명시한다. auth 관련 변경은 *반드시* 머지 전 테스트.
5. **Docker 빌드 가능** — DEPLOY 예정. Phase 1 구현 시점에 Dockerfile + 루트 `docker-compose.yml` 등록 필요. issuer 도메인은 `https://auth.lafamila.xyz`.
6. **서비스 통합 계약 유지** — 이 레포는 다른 서비스들이 참고하는 중앙 auth 계약의 소유자다. OIDC/OAuth2 endpoints, callback/redirect URI 검증, token claim, service permission claim, admin service/client/permission/credential API, service credential scope 정책을 바꿀 때는 consuming service 영향까지 검토한다.
7. **신규 서비스 onboarding 지원** — admin console 과 문서는 새 서비스가 준비해야 할 항목을 계속 설명할 수 있어야 한다: `serviceKey`, permission definitions, OIDC client, redirect/callback URI, login/session/token 처리, access denied 정책, backend-to-auth service credential, env var, secret 비노출 원칙.
8. **Service onboarding request 우선** — 새 서비스 등록과 기존 서비스 spec 변경은 service onboarding request 를 통해 진행한다. 서비스가 제출한 approved core spec(`serviceKey`, permission keys, redirect URIs, scopes, client type, PKCE, service credential scopes)은 auth admin 이 임의 수정하지 않는다. 수정이 필요하면 서비스가 update request 를 제출하고 superadmin 이 승인/거절한다. 운영상 disable/archive, credential revoke/rotate, client disable 은 admin 조치로 허용한다.
9. **Admin access 는 superadmin session 기반** — `/admin` UI 와 `/api/admin/**` 는 `x-admin-key` 가 아니라 `accounts.is_super_admin` 계정의 admin session 으로 보호한다. Superadmin 이 없을 때만 bootstrap 을 열고, Google OTP 등록/검증까지 완료되어야 superadmin 생성이 완료된다. OTP 기기 분실 등 복구는 DB 에서 해당 superadmin 을 직접 삭제하고 bootstrap 을 다시 여는 방식으로 처리한다.
10. **Secret one-time exposure** — OTP secret, OIDC client secret, service credential secret, request secret 등 raw secret 은 생성/승인/rotate 과정에서 한 번만 보여준다. 저장 후 재조회 가능한 API/UI 를 만들지 않는다. 브라우저에 노출되는 secret 은 사용자가 직접 등록/저장해야 하는 bootstrap 또는 approval completion 순간으로 제한한다.
11. **Signup and email verification** — 일반 회원가입은 email 인증을 요구한다. 인증번호는 알파벳+숫자 6자리, 5분 유효, email 기준 30분 내 5회 및 IP 기준 1시간 10회 제한을 따른다. 신규 계정은 모든 active service 에 `visitor` 를 받는다.
12. **Cross-repo 영향 보고** — 이 레포의 변경이 다른 repo, 공통 API 계약, auth claim/permission, env var, Docker/deploy 설정, 공통 문서에 영향을 준다고 판단되면 현재 orchestrator 에게 반드시 보고한다. 직접 보고할 수 없으면 워크스페이스 루트 `../.idea/` 에 `{REPO_NAME}_CROSS_REPO_IMPACT_{YYYYMMDD}.md` 형식의 handoff 문서를 남긴다.
13. **사용자 결정 필요사항 에스컬레이션** — 사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않고 작업을 중단한 뒤 현재 orchestrator 에게 전달하여 결정받고 진행한다. orchestrator 에 보고할 수 없으면 workspace root `../.idea/` 에 handoff 문서를 남긴다.

## Feature Workflow (대원칙 #3 의 이 레포 적용)

1. `.idea/` 또는 신규 계획 문서에서 기능을 선택
2. 계획서 작성 — 변경 파일, 인터페이스, **검토 통과 기준** 명시 (unit tests, e2e coverage, migration checks, OIDC conformance 등)
3. 구현
4. 통과 기준 만족 여부 직접 실행/테스트
5. 통과 시 1개의 커밋으로 마무리

## Project Structure & Module Organization

Expected scaffold (현 시점 planning-stage):

- `src/` for NestJS modules, controllers, services, guards, adapters.
- `src/auth/` for login, password validation, sessions, OIDC provider wiring.
- `src/admin/` for admin APIs and embedded admin console integration.
- `src/database/` for PostgreSQL entities, migrations, persistence adapters.
- `test/` for e2e tests; colocate unit tests as `*.spec.ts`.
- `.idea/` for design/decision documents (`oauth-blueprint.md` is the spec).
- `.omx/` is local agent/runtime state and must remain untracked.

## Build, Test, and Development Commands

No package scripts exist yet (planning-stage). After scaffolding, keep these commands:

- `npm install`: install dependencies.
- `npm run start:dev`: run the local server in watch mode.
- `npm run build`: compile TypeScript into `dist/`.
- `npm run lint`: run ESLint.
- `npm run test`: run unit tests.
- `npm run test:e2e`: run integration/OIDC flow tests.

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
- General signup requires email verification. Signup-created accounts receive `visitor` on all active services.
- Normal passwords require at least 8 characters and at least one special character. Admin reset value `123456789` is a forced temporary password and must set a reset-required state so the user changes it after login.

## Security & Configuration Tips

Never commit secrets, private keys, database URLs, or runtime state. Keep issuer, client secrets, cookie settings, and PostgreSQL credentials in environment variables. Auth changes require tests before merge.
