# Todo Web Split Handoff

This repo does not need a new auth behavior change for the todo split. The required auth primitives already exist; the remaining work in `auth-api-nest` is service onboarding setup plus one temporary integration constraint.

## Already Supported

- Service registry and core spec: admins approve the `todo` service through `POST /api/service-onboarding-requests` plus `/api/admin/service-onboarding-requests/{requestId}/approve`.
- Default visitor assignment: approved services always include `visitor`, but auth creates account-service visitor rows lazily on first login instead of bulk-seeding all accounts.
- Service application flow: visitor users can request access through `POST /api/service-applications`, and admins can approve or reject requests through the admin API.
- Account lookup for member invite flows: `GET /api/admin/accounts/service-search?serviceKey=todo&q=...` already exists.

## Manual Admin Data To Create

Submit these records through the service onboarding flow before wiring `todo-api-fastapi` and `todo-web-next`.

### 1. Service Onboarding Request

Submit one request:

```json
{
  "serviceKey": "todo",
  "name": "Todo",
  "description": "Split todo service for todo-web-next and todo-api-fastapi",
  "permissions": [
    { "key": "owner", "label": "Owner", "description": "Todo service owner" },
    { "key": "admin", "label": "Admin", "description": "Todo service administrator" },
    { "key": "user", "label": "User", "description": "Approved todo member" }
  ],
  "oidcClients": [
    {
      "clientId": "todo-web",
      "clientType": "confidential",
      "redirectUris": ["http://localhost:8000/api/session/callback"],
      "postLogoutRedirectUris": [
        "http://localhost:3034",
        "http://localhost:3034/login"
      ],
      "allowedScopes": ["openid", "profile", "email", "service.permission"],
      "requirePkce": true
    }
  ]
}
```

Notes:

- `visitor` is built in automatically for the approved service spec; do not submit it explicitly.
- Auth only stores and issues the permission key. The meaning of `owner`, `admin`, `user`, and `visitor` remains a todo-service concern.

### 2. OIDC Client

For the currently planned split architecture, request one backend-owned confidential client used by `todo-api-fastapi`.

Recommended local-dev values:

Important:

- The redirect URI must exactly match `TODO_OIDC_REDIRECT_URI` configured in `todo-api-fastapi`.
- `todo-api-fastapi` performs the code exchange server-side; the URI is still registered with auth for OIDC validation even if no browser callback route is exposed.
- A separate public `todo-web-next` client is not required for the currently planned backend-owned session flow.
- The confidential client secret is generated and shown once when the onboarding request is approved.

## Service Application Flow For Todo

- A user with a `visitor` token for `todo` can request access through:

```http
POST /api/service-applications
Authorization: Bearer {todo visitor access token}
Content-Type: application/json

{
  "serviceKey": "todo",
  "message": "Requesting todo access."
}
```

- Admin approves that request to a non-visitor permission by posting `targetPermissionDefinitionId` to `POST /api/admin/service-applications/{applicationId}/approve`.

## Account Search For Todo Member Invite

`todo-api-fastapi` can look up candidate accounts through:

```http
GET /api/internal/service-accounts/search?serviceKey=todo&q=lafamila
x-auth-service-key-id: {TODO_AUTH_SERVICE_KEY_ID}
x-auth-service-secret: {TODO_AUTH_SERVICE_SECRET}
```

The response already includes `permissionKey`, which is enough to distinguish current `visitor` users from already approved members.

## Temporary Constraint

Current todo integration uses auth service credentials for backend-to-auth calls:

- service setup is owned by the auth admin/service onboarding flow
- account invite search uses `x-auth-service-key-id` and `x-auth-service-secret`

That is expected for this split. This repo should not implement `AUTH_SERVICE_KEYS_PLAN` as part of the current work.
