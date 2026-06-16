---
status: COMPLETED
summary: "OIDC authorize 에 auth-hosted login 화면을 붙이고 서비스용 legacy credential login 의존을 제거한다."
completed_at: 2026-06-16
completion_reason: "auth-hosted login 구현 및 로컬 검증 완료"
---

# AUTH_HOSTED_LOGIN_PLAN — auth-api-nest execution plan

Canonical orchestration plan:

`../../.idea/AUTH_HOSTED_LOGIN_PLAN.md`

## Repo Responsibility
중앙 auth server 로서 `/oauth/authorize` 요청 중 auth session 이 없는 경우를 자체 login 화면으로 처리한다. 서비스는 중앙 계정 ID/PW 를 직접 받지 않는다.

## Inputs / Dependencies
- OIDC client 와 redirect URI 는 기존 onboarding 데이터가 source of truth 이다.
- `tas_session` signed HttpOnly cookie 는 기존 auth session cookie 로 유지한다.
- signup 은 auth-hosted login 화면에서 링크로 제공한다.
- password reset 링크는 auth-hosted login 화면에 표시하지 않는다. 비밀번호 초기화는 superadmin 에게 오프라인으로 요청하는 운영 방식이다.

## Work Items
1. `/oauth/authorize` 파라미터 검증과 client/redirect 검증은 먼저 수행한다.
2. 검증 후 `tas_session` 이 없으면 JSON/redirect error 대신 auth-hosted login HTML 을 렌더링한다.
3. login form submit 은 원래 authorize query 를 보존한 채 credential 을 검증하고, 성공 시 `tas_session` 을 발급한 뒤 authorize 흐름을 다시 실행한다.
4. login HTML 은 ID 입력, PW 입력, `로그인` 버튼, signup 링크, 실패 메시지 영역만 갖도록 한다.
5. 실패 시 같은 login 화면에 실패 메시지만 표시한다.
6. public JSON `POST /login` 이 서비스용 credential login 으로 남지 않도록 제거하거나 사용처가 없는 내부 호환 범위로 축소한다. todo-api-fastapi 의 기존 의존은 반드시 제거되어야 한다.
7. `password/complete-reset`, signup, admin login 과 auth-hosted OIDC login 의 세션 cookie 충돌 여부를 확인한다.
8. e2e 테스트를 추가/수정한다.

## Acceptance Criteria
- auth session 없이 `/oauth/authorize` 를 열면 auth-hosted login 화면이 표시된다.
- 올바른 ID/PW 입력 후 등록된 redirect URI 로 authorization code 가 전달된다.
- 잘못된 ID/PW 는 redirect 하지 않고 실패 메시지를 표시한다.
- auth-hosted login 화면에 설명성 copy, `Teddy Auth 로 로그인`, password reset 링크가 노출되지 않는다.
- auth-hosted login 화면에는 signup 링크가 노출된다.
- `npm test` 또는 repo 표준 테스트에서 OIDC authorize/token 관련 테스트가 통과한다.

## Report Back To Orchestrator
- public `POST /login` 제거 여부와 남은 사용처.
- todo/body-lab 쪽에서 필요한 redirect URI 또는 env 변경.
- auth-hosted login 화면에서 password reset 강제 계정이 어떤 error 로 처리되는지.

## Decision Escalation
사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.
