# Admin API

Admin routes use the superadmin session cookie issued by `/api/admin/login`.
`x-admin-key` is no longer an admin authorization model.
Internal service-to-service calls must use service credentials issued through the admin API.

## Admin Bootstrap and Login

- `GET /api/admin/bootstrap/status`: returns whether the connected DB needs first-superadmin bootstrap.
- `POST /api/admin/bootstrap/start`: starts first-superadmin setup when no active superadmin exists. Returns a one-time OTP secret and otpauth URI for authenticator registration.
- `POST /api/admin/bootstrap/complete`: verifies the OTP code and completes first-superadmin creation.
- `POST /api/admin/login`: logs in an active superadmin with login ID, password, and Google OTP. Issues an HttpOnly admin session cookie.
- `GET /api/admin/session`: returns the current superadmin session account.
- `POST /api/admin/logout`: revokes the current admin session.

Admin session policy:

- idle expiry: 30 minutes
- absolute expiry: 12 hours
- no refresh token

## Accounts

- `POST /api/admin/accounts`: create an account.
- `GET /api/admin/accounts`: list accounts.
- `GET /api/admin/accounts/service-search?serviceKey={serviceKey}&q={query}`: admin-side account lookup for service member invite flows. Returns each account's current permission key for the target service.
- `GET /api/admin/accounts/{accountId}`: fetch one account.
- `PATCH /api/admin/accounts/{accountId}`: update name, email, or status.
- `POST /api/admin/accounts/{accountId}/reset-password`: set a new password.
- `PUT /api/admin/accounts/{accountId}/services/{serviceId}/permission`: assign the account's single permission for a service.
- `DELETE /api/admin/accounts/{accountId}/services/{serviceId}/permission`: revoke service access.

## Services and Clients

- `POST /api/admin/services`: create a service registry entry. Prefer the service onboarding request flow for new services.
- `GET /api/admin/services`: list services.
- `PATCH /api/admin/services/{serviceId}`: update service metadata or status.
- `POST /api/admin/services/{serviceId}/credentials`: create a service credential. Body: `name`, optional `description`, `scopes`, optional `expiresAt`. Response includes a one-time `secret`.
- `GET /api/admin/services/{serviceId}/credentials`: list service credentials. Response never includes `secret` or `secretHash`.
- `POST /api/admin/services/{serviceId}/credentials/{credentialId}/rotate`: replace the stored secret hash for the same `keyId`. Response includes a new one-time `secret`.
- `POST /api/admin/services/{serviceId}/credentials/{credentialId}/disable`: disable the credential for future internal API use.
- `POST /api/admin/services/{serviceId}/clients`: create an OIDC client.
- `PATCH /api/admin/services/{serviceId}/clients/{clientId}`: update client settings.
- `POST /api/admin/services/{serviceId}/clients/{clientId}/rotate-secret`: replace confidential client secret.

## Service Onboarding Requests

Services that want to integrate with Teddy Auth should submit their desired
auth spec instead of relying on manual admin entry.

Public service-side endpoints:

- `POST /api/service-onboarding-requests`: submit a new service integration request. Response includes a one-time `requestSecret` for future update requests.
- `POST /api/service-onboarding-requests/{requestId}/update`: submit a revised spec. Requires `x-request-secret` or `requestSecret` in the body.

Admin review endpoints:

- `GET /api/admin/service-onboarding-requests?status=pending`
- `GET /api/admin/service-onboarding-requests/{requestId}`
- `POST /api/admin/service-onboarding-requests/{requestId}/approve`: creates or updates service registry, permissions, OIDC clients, and service credentials from the submitted spec. Returns any one-time client/credential secrets.
- `POST /api/admin/service-onboarding-requests/{requestId}/reject`: records a rejection reason.

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

## Permission Definitions

- `POST /api/admin/services/{serviceId}/permissions`: add an active permission key.
- `PATCH /api/admin/services/{serviceId}/permissions/{permissionId}`: edit label, description, or deprecate.
- `POST /api/admin/services/{serviceId}/permissions/{permissionId}/deprecate`: block new assignments.
- `POST /api/admin/services/{serviceId}/permissions/{permissionId}/migrate`: move assignments to another active permission.
- `POST /api/admin/services/{serviceId}/permissions/{permissionId}/remove`: remove if unassigned, or migrate then remove.

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
- newly created accounts receive `visitor` for every active service

Admin password reset may set the temporary password `123456789`; that temporary
password forces the user to choose a policy-compliant password on next login.

## Default Visitor Permission

Every service receives a default permission on creation:

- key: `visitor`
- label: `방문자`
- description: `서비스 신청이 필요함`

When a service is created, all existing active accounts receive that service's `visitor` permission. When an account is created, it receives the `visitor` permission for every active service.

## body-lab Onboarding

Register body-lab through the existing admin API. This creates no local auth
tables in `body-lab-api-nest`; body-lab consumes auth tokens and claims.

Create the service:

```http
POST /api/admin/services
Cookie: tas_admin_session={signed-session-cookie}
Content-Type: application/json

{
  "serviceKey": "body-lab",
  "name": "body-lab",
  "description": "Diet body research service"
}
```

Create the owner permission after the service exists:

```http
POST /api/admin/services/{bodyLabServiceId}/permissions
Cookie: tas_admin_session={signed-session-cookie}
Content-Type: application/json

{
  "key": "owner",
  "label": "Owner",
  "description": "Full body-lab access"
}
```

Create public native OIDC clients. Do not send `clientSecret`.

```http
POST /api/admin/services/{bodyLabServiceId}/clients
Cookie: tas_admin_session={signed-session-cookie}
Content-Type: application/json

{
  "clientId": "body-lab-ios",
  "clientType": "public",
  "redirectUris": ["bodylab://auth/callback"],
  "allowedGrantTypes": ["authorization_code", "refresh_token"],
  "allowedScopes": ["openid", "profile", "email", "service.permission"],
  "requirePkce": true
}
```

```http
POST /api/admin/services/{bodyLabServiceId}/clients
Cookie: tas_admin_session={signed-session-cookie}
Content-Type: application/json

{
  "clientId": "body-lab-mac",
  "clientType": "public",
  "redirectUris": ["bodylab-mac://auth/callback"],
  "allowedGrantTypes": ["authorization_code", "refresh_token"],
  "allowedScopes": ["openid", "profile", "email", "service.permission"],
  "requirePkce": true
}
```

Assign `owner` to the personal body-lab account:

```http
PUT /api/admin/accounts/{accountId}/services/{bodyLabServiceId}/permission
Cookie: tas_admin_session={signed-session-cookie}
Content-Type: application/json

{
  "permissionDefinitionId": "{ownerPermissionDefinitionId}"
}
```

`visitor` remains the default assignment for accounts without explicit body-lab
access. body-lab must treat `visitor` and missing permission as access denied.

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
