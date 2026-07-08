---
status: IN_PROGRESS
summary: "게임 세션 장기 유지를 위한 auth 보강 — 서명키 DB 영속화+JWKS 다중 키, refresh rotation grace, 토큰 TTL env/per-client 설정화, revocation 정합성, 운영 위생"
---

# GAME_PLATFORM_ENHANCEMENT — auth-api-nest execution plan

Canonical orchestration plan: **workspace root** `.idea/GAME_PLATFORM_ENHANCEMENT_IDEA.md` (이 파일 기준 `../../.idea/GAME_PLATFORM_ENHANCEMENT_IDEA.md`). 특히 §1.1 원인 분석, §1.2 이 레포 변경 후보, §8 교차 레포 계약, §9.1/§12 확정 결정.

## Repo Responsibility

게임 플랫폼(및 모든 OIDC 소비 서비스)의 로그인 세션이 auth 쪽 원인으로 끊기지 않게 만든다:
(1) auth 재시작 후에도 기발급 access token 이 계속 검증되고, (2) refresh 중복/응답 유실이 강제 로그아웃(family 폐기)으로 이어지지 않으며, (3) 토큰 수명이 env 와 클라이언트별로 조정 가능해진다. 전부 root plan **Phase 1** 소속.

## Inputs / Dependencies

- 선행 작업 없음. `game-platform-api-nest` Phase 1 과 병행 가능.
- 에러 응답 shape 는 현행 유지(**D2 보류 — `invalid_grant` 정규화 금지**). 소비자(game api)는 400/401/403 을 영구 거절, 5xx 를 일시 장애로 분류한다는 계약 전제.

## Work Items

### 1. Signing key DB 영속화 + JWKS 다중 키 (P0-A1)

1. `src/oidc/signing-key.service.ts` 전면 개정 — 기동 시 `signing_keys` 테이블에서 active key 로드, 없으면 생성 후 INSERT. 테이블/entity 는 이미 존재하나 미사용 (`src/database/entities/signing-key.entity.ts:3-22`, migration `20260521000000-InitialAuthSchema.ts:112`).
2. private key 저장 방식: 컬럼 구조 확인 후 평문 저장 여부 결정 — 암호화가 필요하면 `src/common/crypto/aes-gcm.service.ts` 재사용, 신규 env 키가 생기면 **보고 필수**(원칙 7).
3. 키 상태 모델: `active` 1개 + `retiring` N개. 교체 시 이전 키를 최소 access TTL(15분, Work Item 3 이후엔 env 값) 이상 JWKS 에 유지. `GET /oauth/jwks`(`src/oidc/oidc.controller.ts:68-71`)가 active+retiring 전부 노출.
4. `src/oidc/token.service.ts:151-158` `verifyAccessToken` 을 kid 매칭 다중 키 검증으로 변경. `src/oidc/oidc.module.ts` 에 entity forFeature 등록.

### 2. Refresh rotation grace window (P0-A2)

1. 신규 env `REFRESH_ROTATION_GRACE_SECONDS`(기본 60) — `src/config/app-config.service.ts` + `.env.example`.
2. `token-record.entity.ts` 에 `used_at timestamptz NULL` 추가 + `metadata_json` 에 successor 참조 기록. migration 추가(기존 row 안전).
3. `src/oidc/token.service.ts:102-132` `consumeRefreshToken`: status='used' 재제시가 `used_at` 기준 grace 이내면 family 폐기 대신 **동일 successor 응답을 멱등 재반환**. grace 초과 재사용만 기존대로 `revokeFamily` + 401.
4. 멱등 재반환 구현이 과도하게 복잡하면(성공 응답 원문 보관 문제) 대안 — "grace 이내 재제시는 reuse 판정 없이 새 rotation 1회 허용" — 을 orchestrator 에 보고 후 택일.

### 3. 토큰 TTL env 화 + per-client override (P1-A3)

1. env `ACCESS_TOKEN_TTL_SECONDS`(기본 900) / `REFRESH_TOKEN_TTL_SECONDS`(기본 604800) getter 추가, `src/oidc/token.service.ts:58,76,81,95` 하드코딩 치환. 기본값만 쓰면 현행과 완전 동일해야 함.
2. `oidc-client.entity.ts` 에 `access_token_ttl_seconds` / `refresh_token_ttl_seconds` nullable 컬럼 + migration. 발급 시 우선순위: client override → env → 코드 기본값.
3. service onboarding request/update 스펙과 admin console(clients 화면, 승인 화면)에 두 필드 노출. `docs/examples/` 예시 갱신.
4. **주의(원칙 8)**: game-platform client 의 실제 값 변경(refresh 30일)은 이 레포에서 하지 않는다 — `game-platform-api-nest` 측이 update request 를 제출하고 superadmin 이 승인하는 흐름. 이 레포 책임은 기능 제공까지.

### 4. Revocation 정합성 (P2-A6)

1. 계정 disable(`src/domain/accounts/accounts.service.ts:167-202`)·비밀번호 reset(:204-216) 시 해당 계정의 refresh family 전체 revoke.
2. refresh grant 경로(`src/oidc/oidc.controller.ts:176-193`)에 `account.status` 검사 추가(비활성 → 403 `access_denied`). 장기 세션(D1)의 반대편 안전장치.

### 5. 운영 위생 (P3-A7)

1. authorization code 를 in-memory Map(`src/oidc/authorization-code.service.ts:16-25`, TTL 60초)에서 `token_records`(type='authorization_code') 기반으로 이전 — 재시작 순간의 로그인 실패 제거.
2. token_records 만료/used row 청소(기동 시 + 주기, 또는 refresh 시 opportunistic delete).

### 6. 문서/계약 정리

1. `docs/auth-flows.md` Token Lifetimes 를 env/per-client 기준으로 갱신 + rotation grace 명시.
2. `docs/service-integration.md` 에 "JWKS 는 복수 키 노출 가능, 미지의 kid 는 refetch" 명시.
3. 레포 `CLAUDE.md` 에 신규 env 키·정책 반영.

**작업 순서**: 1 → 2 → 3 → 4 → 5 → 6. (1·2 가 게임 끊김의 직접 원인 제거, 3 은 game api sliding(D1)의 전제)

## Acceptance Criteria

- `npm run build`, `npm run test`, `npm run test:e2e -- --runInBand` 통과.
- 신규 spec: (a) 서비스 인스턴스 재생성 후 이전 인스턴스 발급 토큰 verify 통과, (b) JWKS 다중 키 노출, (c) grace 이내 이중 refresh → 동일(또는 허용된) 응답·family 유지, (d) grace 초과 → family 폐기, (e) client TTL override 적용 발급, (f) 계정 disable 후 refresh 403.
- `.env.example` 에 신규 키 반영: `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_SECONDS`, `REFRESH_ROTATION_GRACE_SECONDS` (+ 서명키 암호화 채택 시 해당 키).
- migration 이 기존 데이터에 안전(nullable/기본값)하고, 기본 env 값만으로는 기존 동작과 무변경.

## Report Back To Orchestrator

- JWKS 다중 키 노출이 다른 소비 서비스(todo, body-lab 등)의 토큰 검증에 영향 없는지 확인 결과.
- onboarding request 스키마에 TTL 필드 추가됨 → **game-platform-api-nest 가 update request 제출 필요**(refresh 30일 적용, 교차 레포 후속).
- 신규 env 키 전체 목록(배포 env 반영 필요).
- grace 구현이 대안 방식으로 결정된 경우 그 내용.

## Decision Escalation

사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받은 뒤 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.
