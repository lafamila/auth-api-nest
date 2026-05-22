---
status: PREPARED
summary: "todo-web-next/todo-api-fastapi 분리에 필요한 auth-api OIDC client와 권한 설정 gap을 확인한다."
---

# TODO WEB SPLIT — auth-api-nest execution plan

Canonical orchestration plan:

`../.idea/TODO_WEB_SPLIT_PLAN.md`

## Repo Responsibility
`auth-api-nest` 는 중앙 OIDC/auth provider로서 새 todo 독립 서비스가 필요한 client/redirect/service permission/account search 요구를 충족하는지 확인한다. 필요하면 최소 설정 또는 seed/admin API gap을 정리한다.

## Inputs / Dependencies
- Root canonical plan: `/Users/lafamila/work/teddy/.idea/TODO_WEB_SPLIT_PLAN.md`
- New frontend: `todo-web-next` local port `3034`
- Backend session owner: `todo-api-fastapi`
- Existing auth blueprint: `auth-api-nest/.idea/oauth-blueprint.md`
- Existing service key plan: root `.idea/AUTH_SERVICE_KEYS_PLAN.md`

## Work Items
1. 현재 auth-api가 `todo` service, `todo` permissions, OIDC client를 admin UI/API로 등록 가능한지 확인한다.
2. FastAPI session flow에 필요한 redirect URI/client 설정을 정리한다.
   - local callback/redirect URI 후보를 `todo-api-fastapi` session implementation과 맞춘다.
   - browser-facing web origin은 `http://localhost:3034` 로 둔다.
3. `todo-api-fastapi` 의 account search 요구가 현재 admin API로만 가능한지 확인한다.
4. service credential 분리 전까지 필요한 env/key gap을 보고한다. 단, `AUTH_SERVICE_KEYS_PLAN.md` 자체 구현은 이번 범위가 아니다.
5. 필요한 경우 seed/admin 문서 또는 `.env.example` gap을 보고한다.

## Acceptance Criteria
- todo 독립 서비스에 필요한 auth-api 설정 목록이 명확하다.
- 구현이 필요한 auth-api 코드 변경이 있으면 파일/endpoint 단위로 보고한다.
- 현재 코드 변경이 필요 없다면 그 근거를 보고한다.
- `npm run build` 또는 관련 auth-api test 실행 필요 여부를 보고한다.

## Report Back To Orchestrator
- todo OIDC client redirect URI, client id, permission enum, service application flow 관련 결정/설정 값을 보고한다.
- service credential plan과 충돌하거나 후속 필요사항이 있으면 root plan으로 보고한다.

## Decision Escalation
사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.
