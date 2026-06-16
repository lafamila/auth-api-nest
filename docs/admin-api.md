# Admin API

Admin routes use the superadmin session cookie issued by `/api/admin/login` or
the first-superadmin `/api/admin/bootstrap/complete` flow.
`x-admin-key` is no longer an admin authorization model.
Internal service-to-service calls must use service credentials issued through the admin API.

## Admin Bootstrap and Login

- `GET /api/admin/bootstrap/status`: returns whether the connected DB needs first-superadmin bootstrap.
- `POST /api/admin/bootstrap/start`: starts first-superadmin setup when no active superadmin exists. Returns a one-time OTP secret, otpauth URI, and QR image data for authenticator registration.
- `POST /api/admin/bootstrap/complete`: verifies the OTP code, completes first-superadmin creation, issues the same HttpOnly admin session cookie as login, and returns the same session response shape: `account`, `idleExpiresAt`, and `absoluteExpiresAt`.
- `POST /api/admin/login`: logs in an active superadmin with login ID, password, and Google OTP. Issues an HttpOnly admin session cookie.
- `GET /api/admin/session`: returns the current superadmin session account.
- `POST /api/admin/logout`: revokes the current admin session.

Admin session policy:

- idle expiry: 30 minutes
- absolute expiry: 12 hours
- no refresh token

The floating Admin Session control is state-based in both `/admin` and
`/service`: while logged out it opens the bootstrap/login panel, and while
logged in its label changes to `Logout` and it immediately revokes the session.
Bootstrap fields are shown only when `bootstrap/status.requiresBootstrap` is
`true`; otherwise the panel shows only login.

## Accounts

- `GET /api/admin/accounts`: list accounts.
- `GET /api/admin/accounts/service-search?serviceKey={serviceKey}&q={query}`: admin-side account lookup for service member invite flows. Returns each account's current permission key for the target service.
- `GET /api/admin/accounts/{accountId}`: fetch one account.
- `PATCH /api/admin/accounts/{accountId}`: update name, email, or status.
- `POST /api/admin/accounts/{accountId}/reset-password`: set a new password.

Accounts are created through `/signup`, not through admin.

## Services and Clients

- `GET /api/admin/services`: list services.
- `GET /api/admin/services/{serviceId}/credentials`: list service credentials. Response never includes `secret` or `secretHash`.
- `POST /api/admin/services/{serviceId}/credentials/{credentialId}/rotate`: replace the stored secret hash for the same `keyId`. Response includes a new one-time `secret`.
- `POST /api/admin/services/{serviceId}/credentials/{credentialId}/disable`: disable the credential for future internal API use.

Service registry creation and core spec changes happen through service onboarding request approval, not direct admin write endpoints.

## Service Onboarding Requests

Services that want to integrate with Teddy Auth should submit their desired
auth spec instead of relying on manual admin entry.

Superadmins can compose the same request from `/service` after logging in with
an admin session. `/admin` is now the review and operations console: it shows
`Service Onboarding Requests`, `Account Access Requests`, account/service
readouts, dashboards, and operational actions, but it does not include the
request builder. `/service` contains the structured request form for service
basics, permission definitions, OIDC clients, redirect/logout URIs, scopes, and
service credentials. Its JSON preview is the exact request body sent to the
public create API.

Public service-side endpoints:

- `POST /api/service-onboarding-requests`: submit a new service integration request. Response includes a one-time `requestSecret` for future update requests.
- `POST /api/service-onboarding-requests/{requestId}/update`: submit a revised spec. Requires `x-request-secret` or `requestSecret` in the body.

Admin review endpoints:

- `GET /api/admin/service-onboarding-requests?status=pending`
- `GET /api/admin/service-onboarding-requests/{requestId}`
- `POST /api/admin/service-onboarding-requests/{requestId}/approve`: creates or updates service registry, permissions, OIDC clients, and service credentials from the submitted spec. Returns any one-time client/credential secrets.
- `POST /api/admin/service-onboarding-requests/{requestId}/reject`: records a rejection reason.

The `requestSecret` returned by the create endpoint is a request-update-only
secret. It lets the requester revise the pending onboarding request before
approval; it is not an OIDC client secret, service credential secret, or value
to put in a consuming service `.env`.

If a pending request is updated with a valid request secret, the previous
pending row is marked `superseded` and the revised request becomes the only
pending revision for that `serviceKey`.

Submitted specs can include:

- service key, name, description
- permission definitions
- OIDC clients, redirect URIs, scopes, client type, PKCE
- service credential names and scopes

Approved core spec fields are owned by the service request. Do not silently edit
`serviceKey`, permission keys, redirect URIs, scopes, client type, or PKCE in the
admin console. Changes require a new update request from the service. Admins may
still disable/archive services, disable clients, and revoke/rotate credentials
as operational controls.

Approval and credential rotation can issue operational secrets. `/admin` shows
those values only in a one-time modal with label/value rows, copy buttons that
copy only the raw value, and concrete `.env` examples containing the issued
values. Overlay clicks, copy clicks, and ordinary modal-body clicks do not close
the modal. Only the top close button or bottom confirmation button closes it,
and closing clears the raw values from browser state. There is no fixed panel or
later UI/API path to retrieve them.

## Permission Definitions

- `GET /api/admin/services/{serviceId}/permissions`: list permission definitions for the approved service spec.

Permission definition writes happen through approved onboarding specs or service access request approval, not ad hoc admin edit routes.

## Audit Logs

- `GET /api/admin/audit-logs`: newest audit events first.

## Service Applications

Visitor users can request service access through:

- `POST /api/service-applications`: requires a bearer access token whose service claim permission is `visitor`. Body: `serviceKey`, optional `message`.

Admins review requests through:

- `GET /api/admin/service-applications?status=pending`
- `POST /api/admin/service-applications/{applicationId}/approve`: body `targetPermissionDefinitionId`
- `POST /api/admin/service-applications/{applicationId}/reject`

## Signup

General user signup is available at `/signup` and through these APIs:

- `POST /api/signup/start`: body `email`. Sends a 6-character alphanumeric verification code.
- `POST /api/signup/complete`: body `loginId`, `name`, `email`, `code`, `password`.

Rules:

- verification codes expire after 5 minutes
- email rate limit: 5 sends per 30 minutes
- IP rate limit: 10 sends per hour
- email is unique across accounts
- normal passwords require 8+ characters and at least one special character
- newly created accounts do not receive eager service rows

Admin password reset may set the temporary password `123456789`; that temporary
password forces the user to choose a policy-compliant password on next login.

## Default Visitor Permission

Every service receives a default permission on creation:

- key: `visitor`
- label: `방문자`
- description: `서비스 신청이 필요함`

No bulk account-service rows are created at account creation or service approval time. During OIDC authorize/token flows, if the account, service, and client are active and the account has no row at all for that service, auth lazily creates an active `visitor` assignment. If a row already exists with a non-active status, auth does not auto-restore it.

## body-lab Onboarding

Register body-lab through the service onboarding request API. This creates no
local auth tables in `body-lab-api-nest`; body-lab consumes auth tokens and
claims, while `body-lab-api-nest` acts as the confidential OIDC client.

If `body-lab` is not already registered in auth, submit a create request with
an import-compatible JSON payload such as:

- [docs/examples/body-lab-service-onboarding-create.json](/Users/lafamila/work/teddy/auth-api-nest/docs/examples/body-lab-service-onboarding-create.json)

Equivalent request body:

```http
POST /api/service-onboarding-requests
Content-Type: application/json

{
  "serviceKey": "body-lab",
  "name": "body-lab",
  "description": "Body Lab API session bridge for native clients",
  "permissions": [
    { "key": "owner", "label": "Owner", "description": "Full body-lab access" },
    { "key": "tester", "label": "Tester", "description": "Limited test and staging access" }
  ],
  "oidcClients": [
    {
      "clientId": "body-lab-api",
      "clientType": "confidential",
      "redirectUris": [
        "http://localhost:3020/session/oidc/callback",
        "https://lab.lafamila.xyz/session/oidc/callback"
      ],
      "allowedScopes": ["openid", "profile", "email", "service.permission"],
      "requirePkce": true
    }
  ],
  "serviceCredentials": []
}
```

If auth already has a `body-lab` service row, submit the revised spec through:

```http
POST /api/service-onboarding-requests/{requestId}/update
x-request-secret: {requestSecret}
Content-Type: application/json

{same body-lab spec payload with your revised fields}
```

The `requestSecret` comes from the original create request lifecycle. It is not
an OIDC client secret, not a service credential secret, and not something that
belongs in `body-lab-api-nest` runtime `.env`.

Approve the onboarding request in `/admin`, then use the existing account
access request flow to move specific body-lab users beyond `visitor`. body-lab
must treat `visitor` and missing permission as access denied.

Approval-time secret handling for body-lab:

- `BODY_LAB_OIDC_CLIENT_SECRET` is shown once and belongs only in
  `body-lab-api-nest` backend configuration.
- No auth internal service credential is required for the current body-lab
  scope, so there is no `BODY_LAB_AUTH_SERVICE_KEY_ID` /
  `BODY_LAB_AUTH_SERVICE_SECRET` pair to configure yet.
- If a future body-lab feature needs auth account search, submit another update
  request that adds a service credential with the `account.search` scope.

## Internal Service Credentials

Internal service credentials use these headers:

- `x-auth-service-key-id`
- `x-auth-service-secret`

Phase 1 internal endpoints:

- `GET /api/internal/service-accounts/search?serviceKey={serviceKey}&q={query}`: requires the `account.search` scope and a credential whose owning service key matches the query `serviceKey`.

Example:

```http
GET /api/internal/service-accounts/search?serviceKey=todo&q=laf
x-auth-service-key-id: asc_todo_abc123
x-auth-service-secret: {raw-secret}
```
