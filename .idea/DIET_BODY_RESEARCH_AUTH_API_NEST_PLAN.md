---
status: PREPARED
summary: "body-lab serviceKey, owner permission, public OIDC clients를 auth-api-nest에 등록/검증한다"
---

# DIET BODY RESEARCH — auth-api-nest execution plan

Canonical orchestration plan:

`../../.idea/DIET_BODY_RESEARCH_IDEA.md`

## Repo Responsibility
`auth-api-nest`는 body-lab의 중앙 인증 계약을 제공한다. body-lab service, permission definition, native public OIDC clients, redirect URI 검증, admin/seed 문서를 준비한다.

## Inputs / Dependencies
- serviceKey: `body-lab`
- permission: `owner`
- default `visitor` remains no-access for body-lab
- OIDC client type: public
- scopes: `openid profile email service.permission`
- audience: `service:body-lab`
- redirect URIs:
  - `bodylab://auth/callback`
  - `bodylab-mac://auth/callback`
- consuming repos:
  - `body-lab-api-nest`
  - `body-lab-app-swift`

## Work Items
1. Confirm auth supports public OIDC clients with custom scheme redirect URIs.
2. Add or document admin/seed workflow for creating body-lab service.
   - serviceKey `body-lab`
   - label/name `body-lab`
   - permission definition `owner`
3. Add or document public clients.
   - `body-lab-ios`
   - `body-lab-mac`
   - client type public
   - no client secret
   - exact redirect URIs
4. Verify token claim contract.
   - audience `service:body-lab`
   - service claim key `body-lab`
   - permission claim `owner`
5. Add docs/handoff for body-lab integration.
   - auth setup steps
   - required env vars for API/app
   - access denied behavior: `visitor`/missing permission rejected by body-lab API
6. Add tests where existing auth test structure supports it.
   - public client with PKCE
   - custom scheme redirect URI validation
   - body-lab service permission claim shape

## Acceptance Criteria
- body-lab can be registered through seed/admin workflow without adding local auth tables to body-lab.
- Public OIDC clients do not require secrets.
- Exact redirect URI validation supports `bodylab://auth/callback` and `bodylab-mac://auth/callback`.
- Docs clearly tell body-lab repos what to configure.
- Relevant auth tests pass.

## Report Back To Orchestrator
- If auth currently rejects custom scheme redirect URIs.
- If public OIDC clients are not supported or need schema/API changes.
- If permission claim shape differs from the body-lab API plan.
- If deploying `auth-api-nest` requires root deploy changes before body-lab can be tested.

## Decision Escalation
사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator 에게 전달해 결정받고 진행한다. orchestrator 에 보고할 수 없으면 workspace root `.idea/` 에 handoff 문서를 남긴다.
