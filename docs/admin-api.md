# Admin API

All admin routes require `x-admin-key: ${ADMIN_API_KEY}` in Phase 1.
`ADMIN_API_KEY` is only for `/api/admin/**`. Internal service-to-service calls must use service credentials issued through the admin API.

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

- `POST /api/admin/services`: create a service registry entry.
- `GET /api/admin/services`: list services.
- `PATCH /api/admin/services/{serviceId}`: update service metadata or status.
- `POST /api/admin/services/{serviceId}/credentials`: create a service credential. Body: `name`, optional `description`, `scopes`, optional `expiresAt`. Response includes a one-time `secret`.
- `GET /api/admin/services/{serviceId}/credentials`: list service credentials. Response never includes `secret` or `secretHash`.
- `POST /api/admin/services/{serviceId}/credentials/{credentialId}/rotate`: replace the stored secret hash for the same `keyId`. Response includes a new one-time `secret`.
- `POST /api/admin/services/{serviceId}/credentials/{credentialId}/disable`: disable the credential for future internal API use.
- `POST /api/admin/services/{serviceId}/clients`: create an OIDC client.
- `PATCH /api/admin/services/{serviceId}/clients/{clientId}`: update client settings.
- `POST /api/admin/services/{serviceId}/clients/{clientId}/rotate-secret`: replace confidential client secret.

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
x-admin-key: ${ADMIN_API_KEY}
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
x-admin-key: ${ADMIN_API_KEY}
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
x-admin-key: ${ADMIN_API_KEY}
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
x-admin-key: ${ADMIN_API_KEY}
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
x-admin-key: ${ADMIN_API_KEY}
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
