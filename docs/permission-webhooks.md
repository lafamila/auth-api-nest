# Permission Webhooks

Auth durably notifies an approved service when an account permission changes
or an access application is rejected. The permission mutation and outbox insert
commit in one PostgreSQL transaction; external HTTP delivery happens later.

## Onboarding

`permissionWebhook` is an optional service-owned onboarding field:

```json
{
  "permissionWebhook": {
    "url": "https://game.example.com/api/auth/webhooks",
    "signingSecretSource": "generated",
    "eventTypes": [
      "permission.updated",
      "service_application.rejected"
    ]
  }
}
```

- `signingSecretSource` defaults to `generated`.
- `eventTypes` defaults to both supported event types and cannot be empty.
- Omitted on update means retain the existing subscription unchanged.
- Explicit `permissionWebhook: null` disables the existing subscription while
  retaining its configuration and delivery history.
- An object creates or updates the approved config and activates it. Endpoint
  URL or event-type changes require another approved onboarding update; admin
  operational APIs cannot edit them.

For `generated`, approval returns the raw value once:

```json
{ "kind": "permission_webhook", "secret": "one-time raw value" }
```

Store it only in the receiver backend, for example `AUTH_WEBHOOK_SECRET`.
Auth encrypts its copy with `ADMIN_OTP_ENCRYPTION_KEY` and never returns it
again. For `environment`, auth derives a fixed env name from `serviceKey`, such
as `PERMISSION_WEBHOOK_SECRET_GAME_PLATFORM`; the value must be at least 32
characters and is not stored in the database.

## Request Contract

```http
POST <approved permissionWebhook.url>
Content-Type: application/json
x-auth-webhook-id: <event UUID>
x-auth-webhook-timestamp: <Unix epoch seconds>
x-auth-webhook-signature: v1=<lowercase hex HMAC-SHA256>
```

The signature input is exactly ``${timestamp}.${rawBody}``. Verify against the
raw request bytes before JSON parsing, enforce a short timestamp tolerance, and
deduplicate by event UUID. Retries keep the same body `id`; the timestamp and
signature are regenerated for each attempt. Any `2xx` response completes the
delivery. Redirects are never followed.

Permission approval or change:

```json
{
  "id": "UUID",
  "type": "permission.updated",
  "occurredAt": "2026-09-22T12:34:56.789Z",
  "serviceKey": "game-platform",
  "accountId": "UUID",
  "data": {
    "permission": "user",
    "previousPermission": "visitor",
    "status": "active",
    "reason": "approved"
  }
}
```

`reason` is `approved`, `changed`, or `revoked`. Revocation sends
`permission: null`, the prior permission key in `previousPermission`, and
`status: revoked`.

Application rejection:

```json
{
  "id": "UUID",
  "type": "service_application.rejected",
  "occurredAt": "2026-09-22T12:34:56.789Z",
  "serviceKey": "game-platform",
  "accountId": "UUID",
  "data": {
    "applicationId": "UUID",
    "status": "rejected",
    "requestedPermission": "user"
  }
}
```

Payloads contain no account profile data, credentials, access tokens, refresh
tokens, or signing secrets.

## Refresh After An Event

The service can use its already stored refresh token with the standard
`grant_type=refresh_token` request. Auth re-reads the account's current active
service permission and mints the new access token with that permission. No auth
logout or interactive login is required. A revoked assignment receives
`403 access_denied` instead.

## Admin Operations

All endpoints require the superadmin session:

```http
GET   /api/admin/services/{serviceId}/webhook
PATCH /api/admin/services/{serviceId}/webhook
POST  /api/admin/services/{serviceId}/webhook/rotate
GET   /api/admin/services/{serviceId}/webhook/deliveries
POST  /api/admin/services/{serviceId}/webhook/deliveries/{eventId}/retry
```

`GET` returns `null` when no subscription exists. Otherwise it returns only
`id`, `serviceId`, `serviceKey`, `endpointUrl`, `secretSource`, `eventTypes`,
`status`, `deliveryEnabled`, `createdAt`, and `updatedAt`. `deliveryEnabled`
reflects the global rollout flag and may be false while subscription status is
active. No secret or ciphertext is exposed.

`PATCH` accepts `{ "status": "active" | "disabled" }`. `POST /rotate` is
available only for generated secrets and returns `{ subscription, secret }`
once. Delivery listing accepts `status=pending|delivered|exhausted`, `page`, and
`pageSize` and returns `{ items, total, page, pageSize, totalPages }`. Manual
retry preserves the event UUID, clears prior outcome fields, and makes the
delivery immediately due.

## Delivery and Security Policy

- Default maximum attempts: 6. Failed attempts retry after 5, 10, 20, 40, and
  80 seconds; the sixth failure becomes `exhausted`.
- Claim tokens and attempt numbers prevent stale workers from overwriting a
  later success or manual retry. A crashed final-attempt lease is swept to
  `exhausted` when it expires.
- `PERMISSION_WEBHOOK_REQUEST_TIMEOUT_MS` is one hard deadline across DNS,
  connection, and the complete response stream. Only the first 1024 response
  bytes are retained for admin diagnostics.
- Public destinations require HTTPS. DNS is resolved for every attempt and the
  HTTP connection is pinned to the validated address.
- HTTP and private/loopback destinations require an exact operator allowlist in
  `PERMISSION_WEBHOOK_TRUSTED_INTERNAL_ORIGINS`; wildcards and paths are not
  accepted. Link-local/metadata, multicast, documentation, and unspecified
  ranges remain blocked even if declared.
- For Docker auth calling a host-native receiver, a local example is
  `PERMISSION_WEBHOOK_TRUSTED_INTERNAL_ORIGINS=http://host.docker.internal:3035`.

## Rollout

Apply additive migration `AddPermissionWebhooks20260922000000`, then set:

```dotenv
PERMISSION_WEBHOOKS_ENABLED=true
PERMISSION_WEBHOOK_REQUEST_TIMEOUT_MS=5000
PERMISSION_WEBHOOK_POLL_INTERVAL_MS=1000
PERMISSION_WEBHOOK_MAX_ATTEMPTS=6
PERMISSION_WEBHOOK_TRUSTED_INTERNAL_ORIGINS=
```

`PERMISSION_WEBHOOKS_ENABLED=false` is the safe default. While false, the worker
does not query the webhook tables and permission mutations do not enqueue
events. Enabling before applying the migration is unsupported.
