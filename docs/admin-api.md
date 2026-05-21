# Admin API

All admin routes require `x-admin-key: ${ADMIN_API_KEY}` in Phase 1.

## Accounts

- `POST /api/admin/accounts`: create an account.
- `GET /api/admin/accounts`: list accounts.
- `GET /api/admin/accounts/{accountId}`: fetch one account.
- `PATCH /api/admin/accounts/{accountId}`: update name, email, or status.
- `POST /api/admin/accounts/{accountId}/reset-password`: set a new password.
- `PUT /api/admin/accounts/{accountId}/services/{serviceId}/permission`: assign the account's single permission for a service.
- `DELETE /api/admin/accounts/{accountId}/services/{serviceId}/permission`: revoke service access.

## Services and Clients

- `POST /api/admin/services`: create a service registry entry.
- `GET /api/admin/services`: list services.
- `PATCH /api/admin/services/{serviceId}`: update service metadata or status.
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
