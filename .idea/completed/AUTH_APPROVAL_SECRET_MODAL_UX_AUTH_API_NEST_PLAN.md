---
status: COMPLETED
summary: "One-time secret modal에 .env 전체 복사와 보관 확인 체크박스를 추가한다."
completed_at: 2026-06-16
completion_reason: "Implemented in public/index.html, covered by updated e2e HTML assertion, and verified with lint/test/build/e2e."
---

# AUTH_APPROVAL_SECRET_MODAL_UX — auth-api-nest execution plan

Canonical orchestration plan:

`../.idea/AUTH_APPROVAL_SECRET_MODAL_UX_PLAN.md`

## Repo Responsibility

`auth-api-nest`는 `/admin`의 one-time secret modal UI를 개선한다. 서비스 onboarding approval과 service credential rotation에서 같은 shared modal이 쓰이므로, 두 경로 모두 `.env` 예시 복사와 명시적 보관 확인 UX를 갖게 한다.

## Inputs / Dependencies

- Root canonical plan: `../.idea/AUTH_APPROVAL_SECRET_MODAL_UX_PLAN.md`
- Target UI file: `public/index.html`
- Existing modal functions:
  - `openSecretModal(title, description, entries, envLines)`
  - `closeSecretModal()`
  - `openApprovalSecretsModal(result)`
  - `openCredentialRotationModal(secret)`
- Existing modal DOM:
  - `#secretModal`
  - `#secretRows`
  - `#secretEnvExamples`
  - `#confirmSecretModal`
- Existing design patterns:
  - `.content-stack button`
  - `.content-stack .inline-actions button`
  - `.inline-actions`
  - `.admin-access-head`
  - `.icon-button`

## Work Items

1. Secret modal markup 수정
   - `Concrete .env examples` heading을 row layout으로 바꾼다.
   - heading 우측 끝에 `.env` 전체 복사용 `Copy` 버튼을 추가한다.
   - `I copied these secrets` 버튼 label을 `Confirm`으로 바꾼다.
   - modal 하단 action row를 만들고, `Confirm`을 우측에 배치한다.
   - `Confirm` 앞에 `secret 을 별도로 보관했습니다` 체크박스를 추가한다.

2. Modal state 초기화/정리
   - `openSecretModal`에서 checkbox unchecked, confirm disabled, copy feedback 초기화.
   - `closeSecretModal`에서 raw entries/envLines뿐 아니라 checkbox/copy feedback도 정리.
   - secret-required modal 여부를 state에 포함한다.
   - approval result에 secret이 없는 경우와 secret이 있는 경우의 confirm gating을 분리한다.

3. `.env` 전체 복사 구현
   - 새 `Copy` 버튼 클릭 시 `state.secretModal.envLines.join('\n')`을 clipboard에 쓴다.
   - 성공 시 `setStatus` 또는 modal-local feedback으로 복사 완료를 표시한다.
   - 실패 시 error status를 표시한다.
   - 기존 개별 `Copy Value` handler는 그대로 유지한다.

4. Confirm gating 구현
   - secret-required modal에서는 checkbox가 checked일 때만 `Confirm` enabled.
   - checkbox 변경 이벤트에서 disabled state를 갱신한다.
   - `Confirm` 클릭 시에만 modal을 닫는다.
   - close icon은 유지하되, 닫으면 raw secret state가 제거된다는 기존 one-time 정책은 유지한다.

5. `/admin` 디자인 패턴 정렬
   - secret modal 내부 버튼에 `/admin` action button과 같은 크기 계열을 적용한다.
   - 버튼 padding/font-size가 다른 admin list action과 크게 다르지 않게 조정한다.
   - heading row, footer row, checkbox label spacing을 정리한다.
   - modal 내부 디자인이 `/service` 페이지 스타일을 끌어오지 않게 한다.

6. 검증
   - JS runtime error가 없도록 event listener 대상 DOM id를 모두 맞춘다.
   - no-secret approval modal도 닫기/confirm 동작이 깨지지 않게 확인한다.
   - 가능하면 browser 수동 확인 또는 정적 grep으로 새 DOM id와 handler 연결을 확인한다.

## Acceptance Criteria

- `Concrete .env examples`와 같은 줄 우측 끝에 `Copy` 버튼이 있다.
- `Copy` 버튼은 secret 값이 포함된 `.env` 예시 전체를 clipboard에 복사한다.
- 개별 `Copy Value` 버튼은 계속 동작한다.
- `I copied these secrets` 문구는 더 이상 표시되지 않고 `Confirm`이 표시된다.
- secret이 있는 modal에서는 `Confirm`이 기본 disabled다.
- `secret 을 별도로 보관했습니다` 체크박스를 체크해야 `Confirm`이 enable된다.
- `Confirm`은 modal 하단 우측에 배치된다.
- `Confirm` 클릭 전에는 modal이 닫히지 않는다.
- `Confirm` 클릭 후 modal이 닫히고 raw secret state가 정리된다.
- modal 버튼 크기/padding/font-size가 `/admin`의 action 버튼 패턴과 일관된다.
- API/DB contract 변경이 없다.
- 아래 검증 명령을 실행하고 결과를 보고한다.

```bash
npm run lint
npm test -- --runInBand
npm run build
npm run test:e2e
```

## Report Back To Orchestrator

- 변경한 DOM id/class/function 목록.
- no-secret approval modal에서 checkbox/confirm을 어떻게 처리했는지.
- clipboard 실패 시 사용자에게 어떤 feedback을 주는지.
- 실행한 검증 명령과 결과.
- 다른 repo 영향 여부. 예상은 없음.

## Decision Escalation

사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.
