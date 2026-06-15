---
status: PREPARED
summary: "admin console 에 서비스 온보딩 요청 작성 UI 를 추가한다."
---

# AUTH_ADMIN_SERVICE_REQUEST_PAGE — auth-api-nest execution plan

Canonical orchestration plan:

`../../.idea/AUTH_ADMIN_SERVICE_REQUEST_PAGE_PLAN.md`

## Repo Responsibility
`auth-api-nest` 는 superadmin 이 `/admin` 안에서 서비스 온보딩 요청을 직접 작성하고 제출할 수 있는 UI 를 제공한다. 기존 public service onboarding request API 와 superadmin 승인/반려 API 는 유지한다.

## Inputs / Dependencies
- 기존 public create API: `POST /api/service-onboarding-requests`
- 기존 public update API: `POST /api/service-onboarding-requests/{requestId}/update`
- 기존 admin review API:
  - `GET /api/admin/service-onboarding-requests?status=pending`
  - `POST /api/admin/service-onboarding-requests/{requestId}/approve`
  - `POST /api/admin/service-onboarding-requests/{requestId}/reject`
- DTO shape: `src/domain/service-onboarding/dto/service-onboarding.dto.ts`
- Admin console: `public/index.html`
- Existing e2e regression surface: `test/app-bootstrap.e2e-spec.ts`

## Work Items
1. Admin console 구조를 확인한다.
   - `public/index.html` 의 admin session/bootstrap gating 을 확인한다.
   - `adminMain` 이 보일 때만 새 요청 작성 UI 가 보이도록 배치한다.

2. Admin console 정보 구조를 정리한다.
   - 좌측 안내성 패널 `Admin Surface` 를 제거한다.
   - 좌측 임시 secret 패널 `Latest Onboarding Secrets`, `Latest Credential Secret` 를 제거한다.
   - `Service Onboarding Requests` 를 admin main 의 최상단 action 영역으로 올린다.
   - `Account Access Requests` 를 그 다음 action 영역으로 올린다.
   - 두 영역은 조회뿐 아니라 승인/반려 action 이 있는 유일한 주요 영역이므로 사용자가 가장 먼저 보게 한다.
   - 나머지 read/operation 영역은 그 아래로 배치한다.

3. 요청 작성 UI 를 추가한다.
   - 제목은 `Create Service Onboarding Request` 또는 기존 UI 톤에 맞는 짧은 이름을 사용한다.
   - Service basics: `serviceKey`, `name`, `description`, `requesterName`, `requesterEmail`.
   - Permissions: `key`, `label`, `description` row 추가/삭제.
   - OIDC clients: `clientId`, `clientType`, `requirePkce`, `redirectUris`, `postLogoutRedirectUris`, `allowedScopes`.
   - Service credentials: `name`, `description`, `scopes`.
   - textarea 는 기존 규칙대로 resize disabled 를 유지한다.
   - 우측 content 영역의 버튼/dropdown 크기 규칙을 유지한다.

4. Payload builder 를 구현한다.
   - 입력값을 `CreateServiceOnboardingRequestDto` shape 로 변환한다.
   - URI/scope list 는 줄바꿈 또는 comma 입력을 정규화한다.
   - 빈 optional field 는 보내지 않거나 DTO 와 호환되는 값으로 정리한다.
   - permission key, client id, redirect URI, credential scope 의 최소 입력 검증을 클라이언트에서 수행한다.

5. JSON preview 를 추가한다.
   - submit 전 생성될 payload 를 보여준다.
   - preview 는 secret 이 아닌 요청 spec 만 포함한다.
   - preview 의 목적은 admin 이 서비스 요청 내용을 승인 전에 눈으로 확인하는 것이다.

6. Submit 흐름을 구현한다.
   - `POST /api/service-onboarding-requests` 를 호출한다.
   - 성공 시 request id, service key, status, revision, `requestSecret` 을 1회 표시한다.
   - `requestSecret` 문구는 "승인 전 요청 수정용 임시 secret이며, 서비스 `.env` 에 넣는 운영 secret 이 아니다" 라는 의미를 분명히 한다.
   - 성공 후 pending request 목록을 refresh 한다.
   - 실패 시 API 에러를 화면에 표시한다.
   - 동일 `serviceKey` pending 또는 이미 등록된 service key 에러는 사용자가 다음 행동을 이해할 수 있게 보여준다.

7. 운영 secret 표시 방식을 모달로 바꾼다.
   - onboarding approval 응답의 `secrets` 를 고정 패널에 저장하지 않는다.
   - credential rotate 응답의 새 secret 을 고정 패널에 저장하지 않는다.
   - 승인/rotate 직후 모달로만 1회 표시한다.
   - 모달에는 각 secret field 를 label/value 로 분리해 보여준다.
   - 각 값 옆에 clipboard copy 버튼을 둔다. 버튼은 label 이 아니라 값만 복사해야 한다.
   - 모달 하단에는 실제 발급값을 포함한 `.env` 예시를 보여준다.
   - 모달이 닫히면 JS state 에서 raw secret 원문을 제거해 UI 로 다시 볼 수 없게 한다.
   - `requestSecret` 은 운영 secret 이 아니므로 별도 생성 결과 영역에서만 설명한다.

8. 기존 update API 호환성을 확인한다.
   - 현재 `ServiceOnboardingService.update()` 가 pending prior request 수정 상황에서 `assertNoPendingForService()` 때문에 새 revision 생성을 막는지 테스트/코드로 확인한다.
   - 실제로 막힌다면, 동일 request id 를 대상으로 한 valid `requestSecret` update 는 기존 pending request 를 supersede 하거나 revision 을 생성할 수 있게 수정한다.
   - 이 보정은 public API 직접 요청과 새 admin UI 모두의 기반 흐름이므로 이번 작업 범위에 포함한다.

9. 문서를 업데이트한다.
   - `docs/admin-api.md`: admin UI 에서 service onboarding request 를 작성할 수 있음을 추가한다.
   - `docs/service-integration.md`: API 직접 제출과 admin UI 제출의 차이, `requestSecret` 과 운영 secret 의 차이, 승인/rotate secret 모달의 1회성 원칙을 정리한다.
   - `CLAUDE.md` 는 기존 원칙이 충분하면 변경하지 않는다. 새 원칙이 필요할 때만 최소 보강한다.

10. 테스트를 보강한다.
   - `test/app-bootstrap.e2e-spec.ts` 의 admin UI surface test 에 새 UI 문구 포함을 확인한다.
   - `Admin Surface`, `Latest Onboarding Secrets`, `Latest Credential Secret` 문구가 제거되었는지 확인한다.
   - `Service Onboarding Requests` 와 `Account Access Requests` 가 HTML 상 먼저 등장하는지 또는 새 layout marker 로 검증한다.
   - secret modal 관련 marker/copy button/env example 문구가 존재하는지 검증한다.
   - public create API 가 여전히 pending request 와 `requestSecret` 을 반환하는지 검증한다.
   - update API 보정을 했다면 valid `requestSecret` 으로 pending request revision 이 가능함을 검증한다.
   - 기존 direct admin write endpoint 제거 테스트는 깨지지 않아야 한다.

11. 검증을 실행한다.
   - `npm run lint`
   - `npm run build`
   - `npm run test`
   - `npm run test:e2e`

12. 통과하면 기능 단위 커밋을 만든다.
   - co-author trailer 는 넣지 않는다.
   - Lore commit protocol 을 따른다.

## Acceptance Criteria
- `/admin` 에 로그인한 superadmin 은 서비스 온보딩 요청 작성 UI 를 볼 수 있다.
- bootstrap 필요 상태나 로그아웃 상태에서는 admin main 과 요청 작성 UI 가 보이지 않는다.
- `Admin Surface`, `Latest Onboarding Secrets`, `Latest Credential Secret` 패널은 제거된다.
- `Service Onboarding Requests` 와 `Account Access Requests` 가 최상단 action 영역으로 배치된다.
- UI 입력값으로 `POST /api/service-onboarding-requests` 요청을 만들 수 있다.
- 생성 성공 시 `requestSecret` 이 1회 표시되고, 운영 secret 이 아님을 설명한다.
- pending 목록 refresh 후 생성된 요청이 보인다.
- API 직접 요청 경로는 기존처럼 유지된다.
- 기존 승인/반려/secret 1회 표시 흐름은 깨지지 않는다.
- 승인/rotate 로 발급되는 운영 secret 은 모달에서만 1회 표시되며, 닫힌 뒤 UI 에서 다시 볼 수 없다.
- 운영 secret 모달은 label 별 secret 표시, 값만 복사하는 clipboard 버튼, 실제 값 포함 `.env` 예시를 제공한다.
- 문서가 새 운영 방식과 secret 구분을 설명한다.
- lint/build/unit/e2e 검증이 통과한다.

## Report Back To Orchestrator
- update API 의 pending revision 버그가 실제로 있었는지, 있었다면 어떻게 수정했는지 보고한다.
- 새 env 가 필요해졌다면 `.env.example` 변경과 함께 보고한다. 현재 계획상 새 env 는 없어야 한다.
- admin UI 에서 승인/rotate 시 표시되는 운영 secret 모달과 요청 생성 시 표시되는 `requestSecret` 흐름이 구분되는지 보고한다.
- 다른 서비스 repo 에 반영해야 할 contract 변경이 생기면 root `.idea/` 에 handoff 를 남긴다.

## Decision Escalation
사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.
