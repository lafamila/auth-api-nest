---
status: IN_PROGRESS
summary: "Auth에 중앙 Notification 도메인, FCM delivery, service scope, OIDC app API, admin 관리와 통합 문서를 구현한다."
---

# AUTH_NOTIFICATION_PLATFORM — auth-api-nest execution plan

Canonical orchestration plan:

`../.idea/AUTH_NOTIFICATION_PLATFORM_PLAN.md`

## Repo Responsibility

이 repo는 중앙 Notification control/data plane을 소유한다. Auth account-service 관계와 service credential scope, device별 explicit consent를 최종 판정하고 FCM delivery, inbox, retention, admin과 서비스 통합 계약을 제공한다. 별도 Notification 서버나 별도 auth 체계를 만들지 않는다.

## Inputs / Dependencies

- serviceKey `notification`, public OIDC client `notification-app`, dev/prod callback과 visitor 정책.
- Noti Dev/Prod Firebase service account는 환경별 secret으로 외부 주입된다.
- Location Todo는 첫 sender이며 자기 credential의 `notifications.send` scope와 registered action target을 사용한다.
- canonical plan의 API/destination/action/retention 계약이 최종 authority다.

## Work Items

1. `notifications.devices.read`, `notifications.send`를 service credential scope 정의·DTO·admin selector·onboarding validation에 추가하고 기존 credential에는 자동 부여하지 않는다.
2. device, subscription, action target, notification, delivery, delivery attempt/idempotency를 위한 TypeORM entities와 forward migration을 만든다. account/service/credential FK와 hard-delete cascade를 검증한다.
3. FCM token을 authenticated encryption으로 저장하고 fingerprint unique lookup만 노출하는 crypto boundary와 전용 env validation을 추가한다.
4. Noti bearer access token의 issuer/signature/expiry/audience `service:notification`과 subject/account status를 검증하는 app guard를 구현한다.
5. 자기 device register/list/update/delete API를 구현한다. token rotation uniqueness, account switch, logout clear, invalid-token disable을 transaction/concurrency test로 고정한다.
6. active account-service assignment가 있는 service만 subscription 후보가 되게 하고 per-device explicit opt-in/out 및 all-device batch 동작을 구현한다. 새 device는 row 없음/OFF로 취급한다.
7. 자기 inbox cursor list/detail/soft-delete API를 구현한다. 삭제 row는 모든 user query에서 제외하고 restore API를 만들지 않는다.
8. internal device list API에 service credential guard와 `notifications.devices.read` scope를 적용한다. opt-in한 active device의 opaque metadata만 반환한다.
9. internal send API에 `notifications.send`, account-service relation, subscription, destination ownership/platform과 payload limit을 적용한다.
10. `Idempotency-Key` + canonical payload hash를 `(service,key)` 기준 7일 보존하고 same payload replay와 conflict를 구분한다.
11. service onboarding create/update spec과 admin UI에 notification action target을 추가한다. targetKey/service ownership, HTTPS base, allowed path, optional custom scheme/fallback을 strict validation한다.
12. send 시 action snapshot을 저장하고 Noti detail에 검증된 metadata만 반환한다. arbitrary URL/open redirect/path traversal을 거절한다.
13. FCM HTTP v1 adapter와 persisted delivery worker를 구현한다. dev/prod는 하나의 환경 credential만 읽고 retry backoff `1m,5m,15m,1h,6h`, terminal/invalid-token 분류를 적용한다.
14. notification body/token/credential을 log하지 않는 sanitized provider result와 audit event를 구현한다.
15. 90일 inbox/soft-delete, 30일 attempt, 90일 disabled device purge와 account hard-delete를 retention/account deletion 경로에 통합한다.
16. Auth admin에 pagination된 device/subscription/notification/delivery 화면과 disable/revoke/action-target 관리 명령을 추가한다. 기존 compact list/button/date UI 규칙을 유지한다.
17. service integration 문서, API 예제, 오류 코드, consent/destination/action/idempotency/retry ownership, onboarding request 예제를 추가한다.
18. `notification` service/public client와 Location Todo update request 예시를 제공한다. 운영 secret/Firebase credential을 seed하거나 commit하지 않는다.
19. unit/e2e에 unauthorized service, scope 없음, 관계없는 account, opt-out, cross-account device, invalid destination/action, duplicate/retry/token rotation/logout/account delete를 포함한다.

## Acceptance Criteria

- empty/current DB migration과 account deletion cascade가 통과한다.
- 기존 service credential 동작은 유지되고 새 scope를 승인받지 않은 credential은 Notification API를 사용할 수 없다.
- Noti visitor가 자기 device/subscription/inbox만 관리하고 cross-account 접근은 거절된다.
- device read/send가 active assignment + explicit device opt-in을 모두 요구한다.
- destination 세 형태, no-destination 결과, idempotent replay/conflict가 계약과 일치한다.
- token/secret/raw provider credential이 API, admin list, log, test snapshot에 노출되지 않는다.
- FCM transient/terminal/invalid token, worker restart/concurrency와 retention이 테스트된다.
- action target allowlist가 arbitrary URL, 다른 service target과 unsafe path를 차단한다.
- `npm run format:check`, `npm run lint`, `npm run build`, unit/e2e test suite가 통과한다.
- docs만 보고 신규 service가 onboarding update와 send 요청을 구성할 수 있다.

## Report Back To Orchestrator

- 확정된 app/internal API DTO와 error/status shape.
- notification-app-flutter가 요구하는 OIDC/Firebase/env 값.
- Location Todo onboarding update JSON과 sender handoff 계약.
- admin UI/DB migration/retention 및 physical FCM verification blocker.

## Decision Escalation

사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator에게 전달해 결정받은 뒤 진행한다. orchestrator에 보고할 수 없으면 workspace root `.idea/`에 handoff 문서를 남긴다.
