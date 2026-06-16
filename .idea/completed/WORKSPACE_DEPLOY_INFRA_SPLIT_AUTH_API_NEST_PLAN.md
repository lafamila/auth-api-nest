---
status: COMPLETED
completed_at: 2026-06-16
completion_reason: "Implemented infra-only root deployment model and repo deployment documentation."
summary: "auth-api-nest 를 root compose 의 앱 서비스가 아닌 독립 운영 배포 서비스로 문서화한다."
---

# WORKSPACE DEPLOY INFRA SPLIT — auth-api-nest execution plan

Canonical orchestration plan:

`../../.idea/WORKSPACE_DEPLOY_INFRA_SPLIT_PLAN.md`

## Repo Responsibility
`auth-api-nest` 는 중앙 OIDC/auth 서비스다. root compose 에 앱 서비스로 등록되는 전제를 제거하고, 자기 repo 안에서 Dockerfile/env/migration/healthcheck/deploy 문서 책임을 가진다.

## Inputs / Dependencies
- root infra 는 PostgreSQL 을 제공할 수 있지만, 운영 DB host/port/user 는 배포 시점 `.env` 로 결정한다.
- issuer 는 기존 `https://auth.lafamila.xyz` 원칙을 유지한다.
- admin bootstrap/session/OTP/env 원칙은 기존 CLAUDE.md 를 유지한다.

## Work Items
1. `CLAUDE.md` 의 "Docker 빌드 가능" 항목에서 root `docker-compose.yml` 등록 필요 표현을 제거한다.
2. `Build/Test/Development Commands` 에 local run 과 Docker build/deploy check 를 구분해 적는다.
3. `.env.example` 이 독립 배포에 필요한 env key 를 모두 포함하는지 확인한다.
4. Dockerfile 이 root compose context 에 의존하지 않는지 확인한다.
5. 필요하면 README 또는 docs 에 독립 배포 시 필요한 env/migration/start command 를 정리한다.

## Acceptance Criteria
- 이 repo 문서에서 auth 앱이 root compose 로 기본 배포된다는 표현이 없다.
- 독립 Docker build 기준이 문서화되어 있다.
- `.env.example` 이 env shape 의 기준으로 유지된다.
- `npm run build` 또는 문서상 지정된 최소 검증 명령이 가능해야 한다.

## Report Back To Orchestrator
- root compose removal 이후 auth DB 접속 주소/env 변경이 필요한 경우.
- `.env.example` 에 새로 추가해야 하는 키.
- Dockerfile 이 독립 배포에 부적합한 경우.

## Decision Escalation
사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.

