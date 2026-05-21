# Teddy OAuth/OIDC Blueprint

## Goal

Teddy workspace에 있는 현재/미래 서비스들이 공통으로 사용할 중앙 인증 서버를 만든다. 이 서버는 Teddy가 직접 승인하거나 API로 생성한 계정만 관리하며, 각 서비스는 이 서버를 OAuth2/OIDC Provider로 신뢰한다.

핵심 목표는 다음과 같다.

- 별도 공개 회원가입 페이지는 만들지 않는다.
- 슈퍼관리자가 계정을 직접 생성하거나 승인 API로 생성한다.
- 현재 서비스와 앞으로 추가될 서비스는 중앙 계정으로 로그인한다.
- 중앙 서버에서 서비스를 등록하고, 서비스별 권한 enum 값을 관리한다.
- 계정마다 서비스별 권한 레벨을 부여한다.
- 각 서비스는 로그인 후 전달받은 권한 레벨을 자기 도메인 규칙에 맞게 해석한다.

이 시스템은 공개 SaaS용 범용 IAM이 아니라, Teddy가 만든 서비스 전용 private OAuth2/OIDC Provider다.

## System Boundary

```text
Browser / Client
      |
      v
Target Service
      |
      | OIDC Authorization Code Flow + PKCE
      v
Central Teddy Auth Server
      |
      +-- Account management
      +-- Service / OIDC client registry
      +-- Service permission enum registry
      +-- Account-service permission assignment
      +-- Token issuing / revocation
      +-- Audit logging
```

중앙 인증 서버가 소유하는 것:

- 계정 생성, 수정, 비활성화
- 비밀번호 인증
- 서비스 등록
- OIDC client 설정
- 서비스별 권한 enum 정의
- 계정별 서비스 접근 권한 부여
- OIDC/OAuth2 토큰 발급
- refresh token 관리
- 권한 변경 이력과 감사 로그

각 서비스가 소유하는 것:

- 자기 서비스 안에서 권한 값이 의미하는 실제 동작
- 서비스 도메인 데이터
- 리소스 단위 권한 판단
- 화면/기능 분기
- 서비스 내부 감사 로그

중앙 서버는 `admin`, `viewer`, `editor` 같은 권한 값을 전달하지만, 그 값이 어떤 메뉴/기능/API를 허용하는지는 각 서비스가 결정한다.

## Confirmed Decisions

- Auth server는 별도 중앙 서비스로 만든다.
- Auth server DB는 서비스 DB와 분리된 PostgreSQL 전용 DB를 사용한다.
- 운영 issuer URL은 `https://auth.lafamila.xyz`로 한다.
- Phase 1부터 admin console UI를 포함한다.
- 첫 연동 대상은 `todo` 서비스로 한다.
- `todo`는 현재 Next.js -> NestJS -> FastAPI 구조에 묶여 있지만, 별도 서비스로 분리할 예정이다.
- `todo` 분리 후 service key는 `todo`로 한다.
- Admin console UI는 별도 Next.js app이 아니라 NestJS auth server 안에 포함되는 SPA로 제공한다.
- 계정당 서비스별 권한은 1개만 허용한다.
- 여러 권한 조합이 필요하면 조합된 별도 permission key를 만든다.
- 서비스 접근 권한이 없는 사용자는 로그인 후 해당 서비스에서 access denied 처리한다.
- refresh token 만료는 7일로 한다.
- refresh token은 초기 구현에서 BFF/server-side session 중심으로 보관한다.
- 기존 계정은 현재 없으므로 password migration/reset은 범위에서 제외한다.
- 외부 IdP는 Phase 2부터 고려한다.
- 슈퍼관리자 계정은 seed script로 생성한다.
- 향후 workspace root에 `agent.md`를 두고, agent 기반 프로젝트 기획 단계에서 OAuth/OIDC 연동 여부, 서비스 권한 구성, 프로젝트 이름과 구조를 함께 결정할 수 있게 한다.

## Recommended Framework

### Recommendation: NestJS + oidc-provider + Dedicated Auth DB

중앙 auth server의 1순위 추천은 **Node.js/NestJS 기반 서버에 `oidc-provider`를 통합하는 방식**이다.

`oidc-provider`는 Node.js에서 OAuth2 Authorization Server와 OpenID Connect Provider를 구현할 수 있게 해주는 라이브러리다. 즉, authorize/token/userinfo/jwks/discovery 같은 OIDC 표준 엔드포인트와 PKCE, revocation, introspection 같은 보안 프로토콜 기능을 직접 손으로 구현하지 않고 가져다 쓰기 위한 프로토콜 엔진이다.

구성:

```text
teddy-auth-server
- NestJS application shell
- oidc-provider mounted for OAuth2/OIDC protocol endpoints
- admin API modules
- login/admin console UI
- dedicated auth DB
- custom oidc-provider adapter backed by auth DB
```

이유:

- 현재 workspace에 Next.js/NestJS/TypeScript가 이미 있어 운영 언어와 개발 패턴을 맞추기 쉽다.
- OIDC/OAuth2는 직접 구현하기보다 검증된 provider 구현체를 써야 한다.
- `oidc-provider`는 Node.js용 OAuth2 Authorization Server + OIDC 구현체이며, discovery, PKCE, revocation, introspection, logout, JWT access token profile 같은 범위를 폭넓게 지원한다.
- `oidc-provider`는 Express/Fastify/Koa 같은 기존 Node HTTP app에 mount할 수 있어 NestJS admin API와 함께 운영하기 좋다.
- 서비스별 권한 enum, 계정 권한, audit log 같은 Teddy 전용 도메인은 NestJS module로 명확히 분리할 수 있다.

주의점:

- `oidc-provider`가 프로토콜을 처리하더라도 계정 관리, login UI, password reset, admin console, rate limit, audit log는 직접 구현해야 한다.
- storage adapter를 auth DB에 맞게 구현해야 한다.
- OAuth/OIDC 설정은 테스트 fixture와 conformance-oriented integration test를 충분히 둬야 한다.

### Candidate Comparison

| Candidate | Fit | Strength | Tradeoff |
| --- | --- | --- | --- |
| NestJS + oidc-provider | Best fit | 현재 TypeScript/Nest/Next 스택과 잘 맞고, OIDC 구현체를 직접 재작성하지 않아도 된다 | adapter/login/admin 운영 코드는 직접 설계 필요 |
| ASP.NET Core + OpenIddict | Strong alternative | OAuth2/OIDC server/client/validation stack이 성숙하고 구조가 명확하다 | .NET 런타임과 운영 경험을 새로 추가해야 한다 |
| Spring Boot + Spring Authorization Server | Enterprise alternative | Spring Security 기반의 OAuth2/OIDC Authorization Server 구현체 | Java/Spring 운영 부담이 크고 현재 workspace와 결이 다르다 |
| Ory Hydra | Product-style alternative | hardened OIDC/OAuth2 server로 프로토콜 구현 부담이 가장 낮다 | Teddy 전용 account/permission/admin UX와 결합하려면 Hydra 주변 login/consent/account 시스템을 별도로 붙여야 한다 |
| FastAPI custom implementation | Not recommended | 현재 FastAPI 서비스와 언어를 맞출 수 있다 | OIDC Provider 구현체를 사실상 직접 만들어야 해서 보안/표준 리스크가 크다 |

결론: Teddy의 현재 스택과 장기 유지보수성을 기준으로는 **NestJS + oidc-provider**를 우선 선택한다. 단, 구현 시작 전에 작은 spike로 authorization code + PKCE, custom adapter, JWKS, userinfo, refresh token rotation까지 가능한지 먼저 검증한다.

### Auth DB Engine Options

| DB | Pros | Cons |
| --- | --- | --- |
| MySQL | 현재 FastAPI 서비스가 이미 MySQL을 사용하므로 운영 경험과 로컬 개발 흐름을 재사용하기 쉽다. 작은 서비스에서는 충분히 단순하고 익숙하다. | JSON/복합 제약/고급 인덱싱/트랜잭션 모델링에서 PostgreSQL보다 덜 편한 지점이 있다. auth 전용 감사 로그와 token family 모델이 복잡해질수록 표현력이 아쉬울 수 있다. |
| PostgreSQL | 인증/권한/audit/token 같은 관계형 모델에 강하고, JSONB, partial index, constraint, transaction 활용이 좋다. 장기적으로 auth 전용 DB로 더 단단하게 운영하기 좋다. | 현재 workspace의 주 DB 흐름과 다르므로 운영 컴포넌트가 하나 늘어난다. 백업/모니터링/로컬 셋업을 새로 잡아야 한다. |

결정: **PostgreSQL**을 사용한다. Auth server는 기존 서비스 DB와 분리되므로, 현재 MySQL에 맞출 필요보다 인증 데이터 무결성, 감사 로그, token rotation 모델을 안정적으로 표현하는 쪽이 더 중요하다.

### Admin Console Packaging

Admin console은 별도 Next.js app으로 분리하지 않고, NestJS auth server 안에 정적 SPA로 포함한다.

이 방식의 장점:

- auth API와 admin UI 배포 단위가 하나라 초기 운영이 단순하다.
- `auth.lafamila.xyz` 한 도메인에서 login, OAuth endpoints, admin console을 같이 제공할 수 있다.
- admin console이 auth server 내부 API만 호출하면 되므로 CORS와 cookie 설정이 단순해진다.

주의점:

- SPA build artifact를 NestJS 배포 파이프라인에 포함해야 한다.
- UI가 커지면 나중에 별도 app으로 분리할 수 있게 API 경계는 명확히 유지한다.

## Core Domain Model

### Account

```text
Account
- id
- loginId
- name
- email
- passwordHash
- status              # active, locked, disabled
- createdAt
- updatedAt
- lastLoginAt
```

`password`는 저장하지 않는다. 반드시 `passwordHash`만 저장한다. 해시는 Argon2id를 우선 검토하고, 운영 편의상 bcrypt를 선택할 수도 있다.

### Service

서비스는 중앙 인증을 사용하는 대상 시스템이다. OIDC 관점에서는 client 또는 relying party에 해당한다.

```text
Service
- id
- serviceKey          # todo, game-admin, portfolio-admin
- name
- description
- status              # active, disabled, archived
- permissionSchemaVersion
- createdAt
- updatedAt
```

### OIDC Client

하나의 서비스가 여러 client를 가질 수 있다. 예를 들어 같은 서비스라도 web, mobile, local-dev client를 분리할 수 있다.

```text
OidcClient
- id
- serviceId
- clientId
- clientSecretHash    # confidential client only
- clientType          # public, confidential
- redirectUris
- postLogoutRedirectUris
- allowedGrantTypes
- allowedScopes
- requirePkce
- status
- createdAt
- updatedAt
```

기본값:

- browser 기반 서비스는 Authorization Code Flow + PKCE 사용
- SPA/public client는 client secret 없음
- server-rendered web/confidential client는 client secret 사용 가능
- redirect URI는 정확 매칭

### Service Permission Definition

각 서비스가 제공하는 권한 enum 값이다. 중앙 서버는 이 enum을 저장하고 계정에 매핑한다.

```text
ServicePermissionDefinition
- id
- serviceId
- key                 # admin, viewer, editor
- label
- description
- status              # active, deprecated, removed
- sortOrder
- createdAt
- updatedAt
- deprecatedAt
- removedAt
```

`key`는 서비스 코드에서 enum처럼 사용할 값이므로 안정적이어야 한다. 운영 중인 권한의 `key` 변경은 원칙적으로 금지하고, 필요하면 migration 작업으로 처리한다.

### Account Service Permission

계정이 특정 서비스에 대해 어떤 권한을 갖는지 나타낸다.

```text
AccountServicePermission
- id
- accountId
- serviceId
- permissionDefinitionId
- status              # active, suspended, revoked
- grantedByAccountId
- grantedAt
- updatedAt
- revokedAt
```

권한 문자열을 직접 저장하지 않고 `permissionDefinitionId`를 참조한다. 이렇게 해야 권한 label/description 변경, deprecated 처리, 권한 이동을 안전하게 관리할 수 있다.

### Audit Log

권한과 계정 변경은 모두 추적한다.

```text
AuditLog
- id
- actorAccountId
- action
- targetType
- targetId
- beforeJson
- afterJson
- ipAddress
- userAgent
- createdAt
```

필수 감사 대상:

- 계정 생성/비활성화/잠금
- 비밀번호 초기화
- 서비스 생성/수정/비활성화
- OIDC client 생성/secret rotation
- 권한 enum 추가/수정/deprecated/removed
- 계정별 권한 부여/변경/회수
- refresh token revoke

## Permission Schema Management

서비스 권한 enum은 단순 CRUD로 다루면 안 된다. 기존 계정에 부여된 권한이 있기 때문이다.

### Supported Operations

| Operation | Behavior |
| --- | --- |
| Add permission | 새 active permission definition 생성 |
| Edit label/description | 기존 계정 영향 없음 |
| Deprecate permission | 신규 부여 차단, 기존 계정은 유지 |
| Remove permission | 기존 계정이 있으면 migration 필수 |
| Merge permission | 기존 권한을 대상 권한으로 일괄 이동 |
| Rename key | 원칙적으로 금지, 필요 시 migrate + deprecate 방식 |

### Permission Removal / Migration Flow

```text
1. Admin requests removal of service permission key
2. Server counts accounts currently assigned to that permission
3. If count is zero, permission can be marked removed
4. If count is greater than zero, admin must choose migration target
5. Server validates target permission belongs to same service and is active
6. In one transaction:
   - move AccountServicePermission rows to target permission
   - mark old permission deprecated or removed
   - increment Service.permissionSchemaVersion
   - write AuditLog
7. Existing access tokens expire naturally or are invalidated by policy
```

권한 enum 변경은 `permissionSchemaVersion`을 증가시킨다. 각 서비스는 토큰 또는 userinfo 응답의 version을 보고 캐시 갱신 여부를 판단할 수 있다.

## OAuth2 / OIDC Protocol Scope

처음부터 OAuth2 + OIDC 방식으로 개발한다. 기본 플로우는 Authorization Code Flow + PKCE다.

### Required OIDC Endpoints

```text
GET  /.well-known/openid-configuration
GET  /oauth/authorize
POST /oauth/token
POST /oauth/revoke
POST /oauth/introspect          # later or internal-first
GET  /oauth/jwks
GET  /oidc/userinfo
GET  /oauth/logout              # later
```

### Required Admin APIs

```text
POST   /admin/accounts
GET    /admin/accounts
GET    /admin/accounts/{accountId}
PATCH  /admin/accounts/{accountId}
POST   /admin/accounts/{accountId}/reset-password

POST   /admin/services
GET    /admin/services
GET    /admin/services/{serviceId}
PATCH  /admin/services/{serviceId}

POST   /admin/services/{serviceId}/clients
PATCH  /admin/services/{serviceId}/clients/{clientId}
POST   /admin/services/{serviceId}/clients/{clientId}/rotate-secret

POST   /admin/services/{serviceId}/permissions
PATCH  /admin/services/{serviceId}/permissions/{permissionId}
POST   /admin/services/{serviceId}/permissions/{permissionId}/deprecate
POST   /admin/services/{serviceId}/permissions/{permissionId}/migrate
POST   /admin/services/{serviceId}/permissions/{permissionId}/remove

PUT    /admin/accounts/{accountId}/services/{serviceId}/permission
DELETE /admin/accounts/{accountId}/services/{serviceId}/permission
GET    /admin/audit-logs
```

Phase 1부터 슈퍼관리자 전용 admin API와 admin console UI를 함께 제공한다.

## Login Flow

```text
1. User opens target service
2. Target service redirects to:
   /oauth/authorize?client_id=...&redirect_uri=...&response_type=code&scope=openid profile email&code_challenge=...
3. Auth server validates client and redirect URI
4. Auth server shows login page if no active auth session exists
5. User logs in with loginId/password
6. Auth server verifies the account and service permission
7. Auth server issues authorization code
8. Target service exchanges code at /oauth/token
9. Auth server issues id_token, access_token, refresh_token according to client policy
10. Target service verifies token with JWKS and uses service permission claim
```

서비스 접근 권한이 없는 계정이면 로그인 자체는 성공할 수 있지만 해당 client authorization은 거부한다.

## Token Strategy

### ID Token

사용자가 누구인지 나타낸다. UI 세션 생성에 사용한다.

권장 claims:

```json
{
  "iss": "https://auth.lafamila.xyz",
  "sub": "account_123",
  "aud": "client_abc",
  "exp": 1710000000,
  "iat": 1709996400,
  "auth_time": 1709996300,
  "email": "teddy@example.com",
  "name": "Teddy",
  "preferred_username": "teddy"
}
```

### Access Token

API 접근과 서비스 권한 판단에 사용한다.

권장 custom claim:

```json
{
  "iss": "https://auth.lafamila.xyz",
  "sub": "account_123",
  "aud": "service:todo",
  "scope": "openid profile email service.permission",
  "https://lafamila.xyz/claims/service": {
    "key": "todo",
    "permission": "admin",
    "permissionSchemaVersion": 3
  }
}
```

claim 이름은 표준 claim과 충돌하지 않도록 namespaced claim을 사용한다.

### Refresh Token

refresh token은 rotation한다.

원칙:

- refresh token은 DB에 hash로 저장한다.
- 재사용 감지 시 token family를 폐기한다.
- 계정 비활성화, 권한 회수, 비밀번호 초기화 시 관련 refresh token을 revoke한다.
- access token은 짧게 유지한다.

### Recommended Token Lifetime

기본 추천값:

```text
access token: 15 minutes
refresh token: 7 days
authorization code: 1 minute
auth session cookie: 8-12 hours
```

15분 access token을 추천하는 이유:

- 권한 변경, 계정 비활성화, 서비스 접근 회수 같은 변경이 비교적 빨리 반영된다.
- 너무 짧은 5분보다 사용자 경험과 구현 복잡도가 낫다.
- refresh token rotation과 함께 쓰면 일반 웹 서비스에서는 사용자가 자주 다시 로그인하지 않아도 된다.

갱신 방식:

```text
1. 서비스가 access token 만료를 감지한다.
2. 서비스 또는 BFF가 refresh token으로 /oauth/token에 refresh_token grant를 요청한다.
3. auth server가 refresh token hash, 만료, revoke 여부, token family 재사용 여부를 검증한다.
4. 새 access token을 발급한다.
5. refresh token rotation이 켜져 있으면 새 refresh token도 발급하고 기존 refresh token은 폐기한다.
6. 기존 refresh token이 다시 사용되면 탈취 가능성으로 보고 해당 token family를 revoke한다.
```

브라우저 기반 서비스에서는 refresh token을 JavaScript-accessible storage에 두지 않는다. 가능하면 BFF/server-side session 또는 `HttpOnly`, `Secure`, `SameSite` 쿠키를 사용한다.

### Refresh Token Storage Options

| Option | How it works | Pros | Cons |
| --- | --- | --- | --- |
| BFF/server-side session | 서비스의 BFF가 refresh token을 서버 쪽 session store에 보관하고, 브라우저에는 service session cookie만 준다 | refresh token이 브라우저로 직접 노출되지 않는다. XSS에 강하고 서비스별 세션 제어가 쉽다. Next.js/NestJS 같은 BFF 구조와 잘 맞는다 | BFF/session store가 필요하다. 서비스가 많아지면 각 서비스가 session 관리를 구현해야 한다 |
| Auth domain HttpOnly cookie | `auth.lafamila.xyz`가 refresh/session cookie를 보관하고, 서비스는 silent renewal 또는 auth server redirect로 갱신한다 | 중앙 SSO 경험을 만들기 좋다. 서비스가 refresh token을 직접 저장하지 않아도 된다 | 도메인/cookie/SameSite/redirect 흐름 설계가 까다롭다. 브라우저 정책 변화에 영향을 받기 쉽다. 서비스 API 호출용 token 갱신 흐름을 잘 설계해야 한다 |

결정: 초기 구현은 **BFF/server-side session 중심**으로 진행한다. 현재 `todo`가 Next.js -> NestJS -> FastAPI 구조를 갖고 있고, access token과 refresh token을 브라우저 localStorage에 두지 않는 방향이 안전하다. SSO 경험이 더 중요해지는 시점에는 auth domain cookie 기반 세션을 함께 도입할 수 있다.

Auth domain cookie 방식이 어려운 이유:

- `auth.lafamila.xyz` 쿠키는 기본적으로 `auth.lafamila.xyz` 요청에만 전송된다. `todo.lafamila.xyz`나 다른 서비스 API 요청에는 직접 붙지 않는다.
- 서비스를 같은 site 하위 도메인으로 운영하면 일부 쿠키 공유가 가능하지만, `Domain=.lafamila.xyz`, `SameSite`, `Secure`, path 정책을 잘못 잡으면 CSRF 또는 과도한 쿠키 전송 문제가 생긴다.
- 서로 다른 top-level domain이나 외부 도메인 서비스가 생기면 third-party cookie 차단 정책 때문에 iframe/silent renew 방식이 깨질 수 있다.
- refresh token을 auth 도메인 쿠키에만 보관하면, 각 서비스가 자기 API 호출용 access token을 어떻게 얻고 언제 갱신할지 별도 redirect 또는 back-channel 교환 흐름이 필요하다.
- access token을 브라우저 메모리에만 두면 새로고침/탭 간 동기화 UX를 설계해야 하고, 쿠키에 두면 CSRF 방어를 추가해야 한다.
- logout도 어렵다. auth 도메인 세션, 각 서비스 세션, 발급된 refresh token family를 어느 순서로 폐기할지 정해야 한다.
- 브라우저별 SameSite/ITP/storage partitioning 정책 차이 때문에 로컬에서는 되지만 운영 브라우저 조합에서 실패하는 일이 생길 수 있다.

## Security Requirements

- password는 Argon2id 또는 bcrypt로 hash한다.
- client secret도 hash로 저장한다.
- Authorization Code Flow에는 PKCE를 요구한다.
- redirect URI는 exact match만 허용한다.
- access token lifetime은 짧게 둔다.
- refresh token rotation을 구현한다.
- admin API는 슈퍼관리자 권한으로만 접근 가능하다.
- 감사 로그는 수정하지 않는 append-only 성격으로 운영한다.
- JWKS key rotation을 고려한 key id(`kid`)를 사용한다.
- CORS는 필요한 origin만 허용한다.
- 쿠키 사용 시 `HttpOnly`, `Secure`, `SameSite`를 명시한다.

## Service Integration Contract

각 서비스는 다음만 의존한다.

1. OIDC discovery document
2. JWKS endpoint
3. expected issuer
4. expected audience
5. service permission claim

서비스 내부에서는 중앙 권한 값을 자기 enum으로 매핑한다.

예시:

```ts
type TodoServicePermission = "owner" | "admin" | "editor" | "viewer";
```

서비스는 중앙 인증 서버의 DB를 직접 조회하지 않는다. 토큰 검증 또는 userinfo/introspection API만 사용한다.

## Implementation Phases

### Phase 1: OIDC Core and Admin API

목표는 자체 OIDC Provider의 최소 동작과 권한 관리의 핵심 모델을 만드는 것이다.

- 중앙 auth server 신규 생성
- account/service/oidc client/permission/account permission/audit log 스키마 구현
- 슈퍼관리자 seed 계정 생성
- account 생성/수정/비활성화 API
- service 등록 API
- OIDC client 등록 API
- service permission enum 추가/수정/deprecate/migrate API
- account-service permission 부여/회수 API
- login page 또는 최소 login endpoint
- OIDC discovery endpoint
- authorize endpoint
- token endpoint
- JWKS endpoint
- userinfo endpoint
- Authorization Code Flow + PKCE
- access token + id token 발급
- refresh token rotation
- 기존 서비스 하나를 client로 붙여 end-to-end 검증

Phase 1 exit criteria:

- 슈퍼관리자가 계정을 만들 수 있다.
- 슈퍼관리자가 서비스를 등록할 수 있다.
- 서비스별 permission enum을 등록할 수 있다.
- 계정에 서비스별 permission을 부여할 수 있다.
- 사용자가 대상 서비스에서 중앙 로그인으로 인증된다.
- 대상 서비스가 access token을 검증하고 permission claim으로 분기할 수 있다.
- 권한 변경과 토큰 발급 이력이 audit log에 남는다.
- access token 만료 후 refresh token rotation으로 세션이 갱신된다.

### Phase 2: Admin Console and Operational Hardening

목표는 Phase 1의 관리 기능을 실제 운영 가능한 관리 콘솔과 운영 정책으로 고도화하는 것이다.

- Phase 1 admin console UI 고도화
- 계정 검색/생성/잠금/비활성화/비밀번호 초기화
- 서비스 등록/수정/비활성화 UI
- OIDC client 관리 UI
- redirect URI 관리
- client secret rotation UI
- 권한 enum 관리 UI
- 권한 삭제/병합 시 영향 계정 preview
- 계정별 서비스 권한 bulk update
- audit log viewer
- refresh token revoke UI
- login session 관리
- 서비스별 접근 현황 대시보드
- 운영용 설정 분리
- rate limit
- brute-force login protection
- account lock policy
- password policy
- DB migration 체계 정리
- backup/restore 절차 문서화
- Google/Kakao/GitHub 등 외부 IdP 연결 검토 및 1개 이상 spike
- agent 기반 프로젝트 기획 문서(`agent.md`)와 연결되는 OAuth/service permission checklist 작성

### Phase 3: Existing Service Migration

목표는 현재 Teddy workspace의 기존 서비스들을 중앙 인증으로 리팩토링하는 것이다.

- 현재 서비스별 local user/auth 구조 조사
- 서비스별 OIDC client 생성
- `todo`를 별도 서비스로 분리하는 구조 설계
- Next.js frontend OIDC login 연동
- NestJS BFF token validation 연동
- FastAPI token validation 연동
- 기존 user id와 central account id 매핑 전략 수립
- 기존 계정이 없으면 migration 없이 신규 계정 seed/admin 생성으로 시작
- 기존 admin/isAdmin 같은 필드를 service permission으로 이동
- 서비스별 권한 enum 정의
- 기존 서비스 API에서 user identity source를 중앙 token 기준으로 변경
- 서비스별 audit log에 central account id 기록

### Phase 4: Advanced OAuth/OIDC Features

목표는 private system을 넘어 장기 운영 가능한 OIDC Provider에 가깝게 만드는 것이다.

- OIDC logout / RP-initiated logout
- token introspection endpoint 안정화
- token revocation endpoint 고도화
- device authorization flow 검토
- client credentials flow for service-to-service
- machine account/service account 모델
- JWKS key rotation 자동화
- multiple signing keys lifecycle
- consent screen 필요 여부 검토
- scope/resource server 모델 정교화
- per-client token lifetime 정책
- per-service claim mapping policy
- external identity provider 연결 준비

### Final Scope

최종적으로는 다음 수준을 목표로 한다.

- Teddy가 만든 모든 서비스의 중앙 login provider
- 서비스별 OIDC client registry
- 서비스별 권한 enum registry
- 계정별 서비스 접근/권한 관리
- admin console 기반 운영
- 서비스별 권한 변경 migration 지원
- refresh token rotation과 강제 revoke
- audit log 기반 변경 추적
- JWKS key rotation
- service-to-service 인증
- 기존 서비스 전체 중앙 인증 전환
- 나중에 필요하면 Google/Kakao/GitHub 같은 외부 IdP 연결
- 나중에 필요하면 회원가입 신청/승인 workflow 추가

## Decisions Needed

아래 사항은 아직 구현 전에 결정해야 한다.

1. `teddy-auth-server`를 독립 NestJS repo로 둘지, 다른 repo 구조로 둘지 결정한다.
2. access token 15분 기본값을 확정할지, 더 짧은 5분 또는 더 긴 30분으로 조정할지 결정한다.
3. access denied 화면/동작을 각 서비스가 직접 구현할지, auth server가 표준 에러 페이지를 제공할지 결정한다.
4. Phase 2 외부 IdP 중 첫 provider를 Google, Kakao, GitHub 중 무엇으로 할지 결정한다.
