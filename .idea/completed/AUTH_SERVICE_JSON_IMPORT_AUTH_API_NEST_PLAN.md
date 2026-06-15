---
status: COMPLETED
summary: "/service JSON import 로 service onboarding request form 을 자동 채운다."
completed_at: 2026-06-15
completion_reason: "JSON import UI/helper/docs/tests 구현과 lint/build/unit/e2e 및 local smoke 검증이 완료됨."
---

# AUTH_SERVICE_JSON_IMPORT — auth-api-nest execution plan

Canonical orchestration plan:

`../../.idea/AUTH_SERVICE_JSON_IMPORT_PLAN.md`

## Repo Responsibility
`auth-api-nest` 는 `/service` 페이지의 service onboarding request builder 에 JSON import UX 를 추가한다. JSON 파일을 드래그앤드롭 또는 파일 선택으로 첨부하면 form state 를 전체 교체하고, requester 정보는 현재 로그인된 admin session account 기준으로 강제해야 한다.

## Inputs / Dependencies
- Root plan: `../../.idea/AUTH_SERVICE_JSON_IMPORT_PLAN.md`
- `/service` UI: `public/service.html`
- Current service page route: `src/service-page.controller.ts`
- Service onboarding DTO: `src/domain/service-onboarding/dto/service-onboarding.dto.ts`
- Docs:
  - `docs/service-integration.md`
- Tests:
  - `test/app-bootstrap.e2e-spec.ts`

## Work Items
1. `/service` import UI 추가
   - `public/service.html` 의 request builder 상단에 JSON import 영역을 추가한다.
   - 드래그앤드롭 drop zone 을 제공한다.
   - 파일 선택 input/button 도 제공한다.
   - import 상태 메시지 영역을 별도로 둔다.

2. requester field read-only 전환
   - `requesterName`, `requesterEmail` input 을 read-only 로 만든다.
   - 로그인 session 이 확인되면 해당 account 의 `name`, `email` 로 채운다.
   - reset 후에도 session 이 있으면 requester field 를 비우지 말고 현재 session 값으로 복원한다.

3. JSON import parser 구현
   - 파일 내용을 browser-side 로 읽고 `JSON.parse` 한다.
   - top-level object 가 아니거나 JSON parse 실패 시 기존 form state 를 변경하지 않고 오류 메시지를 표시한다.
   - 지원 top-level field:
     - `serviceKey`
     - `name`
     - `description`
     - `permissions`
     - `oidcClients`
     - `serviceCredentials`
     - `requesterName`
     - `requesterEmail`
   - `requesterName`, `requesterEmail` 은 accepted-known field 로 보되 값을 사용하지 않는다.
   - 그 외 unknown top-level field 는 submit payload 에 포함하지 않고 경고로 표시한다.

4. import normalization
   - import 는 현재 form state 를 전체 교체한다.
   - `permissions` 는 배열이어야 하며 `{ key, label, description }` 로 정규화한다.
   - permission key `visitor` 는 제거하고 경고를 표시한다.
   - `oidcClients` 는 배열이어야 하며 form state 에 맞게 변환한다.
     - `clientType` 은 `public` 또는 `confidential` 만 허용한다.
     - `redirectUris`, `postLogoutRedirectUris`, `allowedScopes` 는 배열이면 줄바꿈 문자열로 변환한다.
     - `requirePkce` 가 없으면 `true` 로 둔다.
   - `serviceCredentials` 는 배열이어야 하며 `{ name, description, scopes }` 로 정규화한다.
   - 배열 field 가 배열이 아니면 오류로 처리하고 state 를 변경하지 않는다.

5. requester override 강제
   - import 직후 `state.adminSession.name`, `state.adminSession.email` 을 draft/form 에 적용한다.
   - `buildServiceRequestPayload()` 또는 submit 직전 helper 에서 requester 값을 현재 session 기준으로 다시 강제한다.
   - JSON preview 에도 로그인 계정 기준 requester 값이 보이게 한다.

6. render / validation 연동
   - import 성공 후 `renderServiceRequestRows()` 와 `renderServiceRequestPreview()` 를 호출한다.
   - import warning 은 `setServiceRequestMessage` 와 별도의 import message 중 어느 하나로 명확히 노출한다.
   - 기존 submit validation 은 유지한다.

7. docs 업데이트
   - `docs/service-integration.md` 에 `/service` JSON import 사용법을 추가한다.
   - requester field 는 JSON 값이 아니라 로그인 계정 기준으로 덮어쓴다는 점을 명시한다.
   - `visitor` permission 은 import 중 제거된다는 점을 명시한다.

8. tests 업데이트
   - `test/app-bootstrap.e2e-spec.ts` 또는 관련 surface test 에 `/service` HTML marker 를 추가한다.
   - 최소 검증:
     - import drop zone/input marker 존재
     - requester read-only marker 존재
     - unknown field warning 또는 related function marker 존재
     - visitor permission filtering marker 존재
   - 가능하면 import parser helper 가 분리된다면 unit/static 검증을 추가한다. 단, 새 dependency 는 추가하지 않는다.

9. 검증 실행
   - `npm run lint`
   - `npm run build`
   - `npm run test`
   - `npm run test:e2e`
   - 가능하면 local `npm run start` 또는 `PORT=... npm run start` 로 `/service` smoke 를 확인한다. 이미 떠 있던 프로세스는 종료하지 않는다.

10. 커밋
   - 통과하면 기능 단위 commit 을 만든다.
   - Co-authored-by trailer 는 넣지 않는다.
   - Lore commit protocol 을 따른다.

## Acceptance Criteria
- `/service` 에 JSON 드래그앤드롭 영역과 파일 선택 버튼이 있다.
- valid request JSON import 시 기존 form state 가 전체 교체된다.
- import 후 JSON preview 가 즉시 갱신된다.
- JSON 의 `requesterName`, `requesterEmail` 은 무시되고 현재 session account 의 `name`, `email` 이 form/preview/submit payload 에 적용된다.
- requester input 은 read-only 로 표시된다.
- unknown top-level field 는 submit payload 에 포함되지 않고 경고로 표시된다.
- `visitor` permission 은 import 중 제거되고 경고로 표시된다.
- invalid JSON 또는 잘못된 field 타입은 기존 form state 를 변경하지 않고 오류를 표시한다.
- docs 가 JSON import 사용법과 requester override 원칙을 설명한다.
- lint/build/unit/e2e 검증이 통과한다.

## Report Back To Orchestrator
- JSON parser/normalizer 를 service.html 내부에 둘지 별도 helper 로 분리했는지 보고한다.
- 새 env/migration/backend API 변경이 생겼다면 보고한다. 현재 계획상 없어야 한다.
- requester override 가 import와 submit 양쪽에 적용됐는지 보고한다.
- browser smoke 를 못 했다면 이유와 남은 위험을 보고한다.

## Decision Escalation
사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.
