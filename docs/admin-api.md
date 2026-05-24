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
