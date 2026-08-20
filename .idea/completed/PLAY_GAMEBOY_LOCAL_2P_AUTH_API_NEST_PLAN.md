---
status: COMPLETED
completed_at: 2026-08-21
completion_reason: "select_account, browser-bound single-use hosted-login transactions, and exact P1 SSO preservation were implemented and passed build/lint/unit/e2e/security review."
summary: "P1 tas_session을 유지하면서 요청별로 다른 계정을 선택해 OIDC code를 발급하는 select_account 흐름을 구현한다."
---

# PLAY GAMEBOY LOCAL 2P — auth-api-nest execution plan

Canonical orchestration plan:

`../.idea/completed/PLAY_GAMEBOY_LOCAL_2P_PLAN.md`

## Repo Responsibility

`auth-api-nest`는 P1의 signed HttpOnly `tas_session`을 변경하지 않으면서 Play의 P2 authorization request가 다른 실제 계정을 선택할 수 있는 OIDC account-selection 계약을 제공한다. P2 token은 정상 service permission claim을 포함하지만 P2 인증은 Auth SSO의 기본 계정을 교체하지 않는다.

## Inputs / Dependencies

- serviceKey: `gbc-porting`
- existing client: `gbc-porting-web`
- existing callback URI를 그대로 사용하며 신규 client secret/redirect URI는 요구하지 않는다.
- P2 request: `prompt=select_account`
- P1 SSO cookie: `tas_session`, 인증 전후 P1 유지
- Play가 P1/P2 동일 subject를 최종적으로 거부한다.

## Work Items

1. OIDC discovery의 `prompt_values_supported`를 실제 지원값과 일치시키고 `select_account`를 추가한다.
2. authorize request에서 지원하지 않는 prompt 조합을 명시적으로 거부하고 `select_account`를 validated request로 보존한다.
3. `tas_session` P1이 있는 `select_account` 요청에 account-selection hosted page를 렌더한다.
4. 화면은 현재 P1과 `다른 계정 사용`을 제공한다. password는 Auth hosted form에서만 입력받는다.
5. ordinary hosted login과 account selection 모두 server-side single-use login transaction을 만들고 browser-bound signed HttpOnly cookie로 묶는다. hosted POST DTO는 transaction handle과 credential/selection action만 허용하고 OAuth authorize parameters를 다시 받지 않는다.
6. 현재 P1을 선택하면 P1 code를 발급하되 cookie는 변경하지 않는다.
7. 다른 자격증명으로 P2를 인증하면 P2 code를 발급하되 `setSessionCookie`를 호출하지 않아 기존 P1 `tas_session`을 유지한다.
8. account status, password reset, service status, lazy visitor, permission claim, PKCE, redirect URI 검증은 primary login과 동일하게 적용한다.
9. current source의 불완전한 `prompt=login` 잔여 코드/metadata/test를 이 기능에 재사용하지 않는다. 사용자가 삭제하기로 한 계약과 실제 코드가 일치하도록 정리한다.
10. account-selection page에 CSRF/clickjacking 방어와 기존 credential error handling을 적용한다.
11. `docs/auth-flows.md`와 service integration 문서에 `select_account`의 SSO 보존 의미를 기록한다.

## Required Tests

- P1 `tas_session`이 있는 normal authorize는 기존처럼 P1 code를 발급한다.
- 같은 agent에서 `prompt=select_account`는 account-selection page를 반환한다.
- 다른 P2 credential을 제출하면 code/token subject가 P2다.
- 위 P2 flow 전후의 `tas_session` cookie 값과 이후 normal authorize subject가 P1이다.
- current P1 선택도 P1 code를 반환하고 cookie를 변경하지 않는다.
- invalid P2 credential은 selection/login page를 다시 표시하며 P1 cookie를 유지한다.
- P2 visitor token은 `visitor` service permission claim을 가진다.
- disabled/reset-required account와 inactive service/client는 기존 정책대로 거절된다.
- unknown/unsupported prompt와 `prompt` DTO validation 오류를 계약에 맞게 처리한다.
- `property prompt should not exist` 회귀 테스트를 추가한다.
- login CSRF, hidden authorize parameter tampering, transaction replay/expiry/concurrent tab을 거부한다.

## Acceptance Criteria

- `prompt=select_account`가 discovery와 실제 동작에서 일치한다.
- P2 authorization 중 P1 `tas_session`이 생성·삭제·교체되지 않는다.
- password/token/client secret이 Play origin이나 브라우저 message payload로 노출되지 않는다.
- primary OIDC, refresh rotation, revoke, hosted login, signup 회귀 테스트가 모두 통과한다.
- `npm run build`
- `npm run lint`
- `npm run test`
- `npm run test:e2e`

## Report Back To Orchestrator

- 최종 prompt metadata와 authorize/login request contract
- Play가 전달해야 하는 query parameter와 callback 변경 유무
- P1 cookie 불변을 증명한 e2e 결과
- 기존 서비스 중 제거되는 `prompt=login` 잔여 계약을 소비하는 곳이 발견될 경우 그 영향

## Decision Escalation

사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator에게 전달해 결정받은 뒤 진행한다. orchestrator에게 보고할 수 없으면 workspace root `.idea/`에 handoff 문서를 남긴다.
