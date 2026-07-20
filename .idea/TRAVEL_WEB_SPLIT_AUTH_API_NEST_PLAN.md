---
status: PREPARED
summary: "travel 서비스 온보딩 JSON을 기준으로 auth 등록 가능성을 확인하고 필요한 경우 문서 예시를 추가한다."
---

# TRAVEL WEB SPLIT — auth-api-nest execution plan

Canonical orchestration plan:

`../.idea/TRAVEL_WEB_SPLIT_PLAN.md`

## Repo Responsibility
`auth-api-nest`는 central OIDC provider다. 이번 계획에서 auth core code 변경은 예상하지 않는다. 다만 `travel` service onboarding spec이 현재 auth의 service request/import/approval 구조로 처리 가능한지 검증하고, 필요하면 문서 예시만 보강한다.

## Inputs / Dependencies
- serviceKey: `travel`
- permissions: `user`, `admin`
- OIDC client: `travel-api`
- redirect URIs:
  - `http://localhost:8010/api/session/oidc/callback`
  - `https://map.lafamila.xyz/api/session/oidc/callback`
- post logout redirect URIs:
  - `http://localhost:3043/login`
  - `https://map.lafamila.xyz/login`
- scopes: `openid`, `profile`, `email`, `service.permission`
- service credential scopes: `account.search`, `permission.read`

## Work Items
1. 현재 `/service` JSON import와 service onboarding request approval이 위 spec을 수용하는지 확인한다.
2. `visitor`는 auth가 기본 관리하므로 onboarding JSON permissions에는 넣지 않는다.
3. `account.search`와 `permission.read` service credential scope가 현재 enum/validation에 있는지 확인한다.
4. code change 없이 충분하면 변경하지 않고 확인 결과만 보고한다.
5. 문서 예시가 필요하다고 판단되면 `docs/examples/travel-service-onboarding-create.json` 같은 예시만 추가한다.
6. core API나 DB schema 변경이 필요해 보이면 임의 구현하지 말고 orchestrator에게 보고한다.

## Acceptance Criteria
- travel onboarding JSON이 auth current contract에 맞는지 확인된다.
- auth code change가 없으면 테스트 실행 필요 여부를 보고한다.
- auth code/doc change가 있으면 `npm run build && npm run lint && npm run test && npm run test:e2e` passes.
- raw client secret/service credential secret은 auth에서 한 번만 노출되고 `travel-api-fastapi` backend env로만 이동해야 한다는 점이 유지된다.

## Report Back To Orchestrator
- auth admin에서 등록/승인해야 하는 JSON과 승인 후 복사해야 하는 env names
- current auth가 travel spec을 수용하지 못하는 경우 필요한 auth 변경점
- 운영 auth DB에 이미 `travel` service가 있는지 여부

## Decision Escalation
사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.
