---
status: PREPARED
summary: "service credential 에 sync scope 를 추가하고, 다른 서비스가 제시받은 credential 을 검증할 수 있는 내부 엔드포인트를 신설한다."
---

# TODO OFFLINE SYNC — auth-api-nest execution plan

Canonical orchestration plan:

`../.idea/TODO_OFFLINE_SYNC_PLAN.md`

## Repo Responsibility

todo 로컬 스택 ↔ NAS 원격 동기화의 **기기 인증**을 auth 가 중앙에서 관리할 수 있게 만드는 최소 추가만 담당한다. 동기화 로직·스키마·데몬은 `todo-api-fastapi` 의 책임이고 이 레포는 관여하지 않는다.

핵심은 하나다: **지금 auth 는 "호출자 자신의 credential" 만 guard 로 검증하고, "제3자가 제시한 credential 이 유효한가"를 물어볼 창구가 없다.** 그 창구를 만든다.

이 엔드포인트는 todo 전용이 아니라 **범용 서비스 간 인증 수단**으로 설계한다.

## Inputs / Dependencies

- 기존 자산 (이미 존재, 확인됨):
  - `src/database/entities/service-credential.entity.ts` — `SERVICE_CREDENTIAL_SCOPE_DEFINITIONS`(현재 `account.search`, `permission.read`), `SERVICE_CREDENTIAL_SCOPE_KEYS`, `status: 'active' | 'disabled'`, `keyId`(unique) + `secretHash`, `service` 관계
  - `src/internal/internal-service-credentials.guard.ts` — 호출자 credential 검증 (현재 **scope 검사 없음**)
  - `src/internal/internal-service-accounts.controller.ts`, `internal-service-applications.controller.ts` — 기존 internal 엔드포인트 2개
  - `src/admin/controllers/admin-service-credential-scopes.controller.ts`, `src/service-page.controller.ts` — 둘 다 `SERVICE_CREDENTIAL_SCOPE_DEFINITIONS` 를 그대로 반환 → **상수 하나가 단일 소스**
  - `src/domain/service-credentials/dto/service-credential.dto.ts` — `@IsIn(SERVICE_CREDENTIAL_SCOPE_KEYS, { each: true })`
  - `src/database/entities/audit-log.entity.ts` — 감사 로그
- 사용자 작업(코드 아님): 이 작업이 끝난 뒤 관리화면에서 **노트북용 credential** 을 발급한다 (serviceKey `todo`, scope `sync`, 새 `keyId`). 원칙 3에 따라 요청 기반 온보딩이며 secret 은 1회만 노출된다.

## Work Items

1. **`sync` scope 키 추가**
   - `SERVICE_CREDENTIAL_SCOPE_DEFINITIONS` 에 항목 추가:
     `{ key: 'sync', label: 'Data Sync', description: 'Allows a service deployment to push/pull data changes to another deployment of the same service.' }`
   - 관리화면 목록·DTO 검증은 이 상수를 읽으므로 별도 수정이 필요한지 확인하고, 하드코딩된 곳이 있으면 상수 참조로 바꾼다.

2. **credential 검증 엔드포인트 신설**
   - `POST /api/internal/service-credentials/verify`
   - 호출자 인증: 기존 `InternalServiceCredentialsGuard` 를 그대로 적용한다 (호출자는 자기 credential 로 자신을 증명한다).
   - 요청 본문:
     ```json
     { "keyId": "asc_todo_laptop_a1b2", "secret": "...", "requiredScope": "sync" }
     ```
   - 응답 (성공/실패 모두 200, 판정은 `valid` 로):
     ```json
     { "valid": true, "serviceKey": "todo", "scopes": ["sync"], "status": "active" }
     { "valid": false, "reason": "invalid_credential | disabled | scope_missing" }
     ```
   - 규칙:
     - secret 비교는 기존 credential 검증 로직(`secretHash`)을 **재사용**한다. 해시 비교 로직을 새로 쓰지 않는다.
     - `status === 'disabled'` 는 `valid: false`.
     - `requiredScope` 가 주어지면 해당 scope 를 보유해야 `valid: true`. `requiredScope` 미지정이면 scope 검사를 건너뛴다.
     - 실패 이유는 위 3종으로 제한한다 — 존재 여부·소속 서비스 등 추가 정보를 노출하지 않는다.
     - 타이밍 공격 표면을 늘리지 않도록 상수시간 비교를 유지한다.
     - **호출자와 검증 대상이 다른 서비스여도 허용할지**를 결정해 문서화한다. 이번 용도는 같은 serviceKey(`todo`) 내부이므로, 기본은 "호출자와 대상의 serviceKey 가 같을 때만 허용"으로 좁히고 필요해지면 넓히는 방향을 권한다 (좁게 시작하는 편이 안전하다).
   - 감사 로그: 검증 시도(성공/실패, 대상 keyId, 호출자 keyId)를 `audit-log` 에 남긴다.
   - rate limit: 이 엔드포인트는 secret 을 받는 창구이므로 기존 rate limit 정책이 있으면 적용하고, 없으면 orchestrator 에 보고한다.

3. **문서 갱신**
   - repo `CLAUDE.md` 에 신규 scope 와 엔드포인트를 기록한다 (요청/응답 스키마, 호출자 인증 방식, serviceKey 동일성 제약).
   - 이 엔드포인트가 **범용**이라는 점과, todo 동기화가 첫 소비자라는 점을 함께 적는다.

4. **테스트**
   - unit: 유효 / 잘못된 secret / `disabled` / scope 불일치 / `requiredScope` 미지정 — 5케이스
   - e2e: guard 를 통과하지 못한 호출자(자기 credential 없음)가 401/403 을 받는지
   - 기존 internal 엔드포인트 회귀가 없는지

## Acceptance Criteria

- `npm run build`, `npm run lint`, `npm run test`, `npm run test:e2e` 전부 통과.
- 위 5케이스 테스트가 모두 통과한다.
- 관리화면 scope 목록 API 응답에 `sync` 가 나타난다.
- 기존 `service-accounts/search`·`service-applications/status` 동작에 변화가 없다.
- 이 레포는 DB 스키마를 바꾸지 않는다 (scope 는 기존 컬럼에 들어가는 값이다). 마이그레이션이 필요하다고 판단되면 **멈추고 보고**한다.

## Report Back To Orchestrator

- **엔드포인트 계약 확정본** — 경로, 요청/응답 스키마, 실패 이유 문자열, 호출자 인증 헤더. `todo-api-fastapi` 가 이걸 입력으로 구현하므로 문자 그대로 보고한다.
- serviceKey 동일성 제약을 어떻게 결정했는지.
- 노트북용 credential 온보딩에 사용자가 입력해야 하는 항목(serviceKey, scope, 라벨 등).
- rate limit 적용 여부와 방식.
- 감사 로그에 남는 필드.
- 다른 서비스에 영향을 주는 변경이 생겼다면 그 내용.

## Decision Escalation

사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `../.idea/` 에 handoff 문서를 남긴다.

특히 다음은 임의로 정하지 않는다:

- OIDC core protocol·admin UI·기존 guard 의 동작 변경
- credential 스키마 변경이나 마이그레이션
- 검증 엔드포인트를 외부(비-internal) 경로로 노출하는 선택
