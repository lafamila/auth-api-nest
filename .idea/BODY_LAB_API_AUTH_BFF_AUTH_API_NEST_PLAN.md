---
status: IN_PROGRESS
summary: "body-lab onboarding/docs 를 body-lab-api confidential client 중심으로 갱신한다."
---

# BODY_LAB_API_AUTH_BFF — auth-api-nest execution plan

Canonical orchestration plan:

`../../.idea/BODY_LAB_API_AUTH_BFF_PLAN.md`

## Repo Responsibility
`auth-api-nest` 는 body-lab 이 앱 직접 OIDC public client 중심이 아니라 `body-lab-api-nest` confidential client 중심으로 auth 를 붙일 수 있도록 service integration 문서와 request 예시를 갱신한다. Auth core protocol 자체를 바꾸는 작업이 아니라, body-lab service spec 의 intended shape 를 바로 승인/요청할 수 있게 정리하는 작업이다.

## Inputs / Dependencies
- Root plan: `../../.idea/BODY_LAB_API_AUTH_BFF_PLAN.md`
- Current docs: `docs/service-integration.md`
- Current onboarding request API:
  - `POST /api/service-onboarding-requests`
  - `POST /api/service-onboarding-requests/:id/update`
  - `/service` JSON import form
- Target body-lab OIDC client:
  - `clientId`: `body-lab-api`
  - `clientType`: `confidential`
  - `requirePkce`: `true`
  - redirect URIs:
    - `http://localhost:3020/session/oidc/callback`
    - `https://lab.lafamila.xyz/session/oidc/callback`
  - scopes: `openid profile email service.permission`

## Work Items
1. `docs/service-integration.md` 의 body-lab integration 섹션 갱신
   - 기존 `body-lab-ios`, `body-lab-mac` public OIDC client-first 설명을 deprecated/legacy 로 낮춘다.
   - 새 기본 구조를 `body-lab-api` confidential client + body-lab opaque session 으로 설명한다.
   - native app 이 auth client secret, service credential, auth refresh token 을 저장하지 않는다는 점을 명시한다.

2. body-lab service onboarding JSON 예시 추가
   - `/service` JSON import 로 넣을 수 있는 request JSON 예시를 문서에 포함하거나 `docs/examples/` 같은 기존 문서 위치에 추가한다.
   - create vs update 전략을 문서화한다.
     - auth DB 에 `body-lab` service 가 이미 있으면 update request.
     - 없으면 create request.
   - update request 에 필요한 `requestSecret` 은 original request/update lifecycle 값이지 runtime `.env` secret 이 아니라는 점을 명시한다.

3. One-time secret 처리 문서 갱신
   - approval modal 에서 나오는 `BODY_LAB_OIDC_CLIENT_SECRET` 은 `body-lab-api-nest` `.env` 로만 이동한다.
   - no service credential 이므로 이번 범위에서는 `BODY_LAB_AUTH_SERVICE_KEY_ID` / `BODY_LAB_AUTH_SERVICE_SECRET` 같은 env 를 만들지 않는다고 명시한다.

4. Auth API 변경 필요 여부 확인
   - confidential client + PKCE + redirect URI validation 이 현재 OIDC token/authorize 경로에서 정상 작동하는지 테스트 커버리지를 확인한다.
   - 부족하면 auth repo 내 테스트만 보강한다.
   - 새로운 endpoint 를 추가하지 않는다.

5. Tests / verification
   - docs-only 변경이면 build/test 를 최소 확인한다.
   - 테스트 보강이 들어가면 관련 e2e/unit 을 실행한다.

## Acceptance Criteria
- body-lab integration 문서가 `body-lab-api` confidential client 를 기본값으로 설명한다.
- 문서 또는 예시 JSON 만으로 `/service` 에 body-lab update/create request 를 제출할 수 있다.
- native app 에 secret 을 넣지 말아야 하는 경계가 명확히 적혀 있다.
- 이번 범위에서 service credential 이 필요 없다는 점과 future `account.search` 추가 시점이 명시되어 있다.
- 다음 명령이 통과한다.
  - `npm run build`
  - `npm run lint`
  - `npm test -- --runInBand`
  - `npm run test:e2e`

## Report Back To Orchestrator
- 최종 body-lab onboarding request JSON shape.
- approval 후 사용자가 `body-lab-api-nest` 에 넣어야 하는 env key 목록.
- auth core code 변경이 필요했는지 여부.
- 기존 `body-lab-mac` / `body-lab-ios` public clients 를 나중에 DB에서 제거해야 하는지 여부.

## Decision Escalation
사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.
