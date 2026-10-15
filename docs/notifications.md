# Notification Platform Integration

`auth-api-nest` is the central Notification control/data plane. A sender is
authorized by its existing service credential, and a recipient is eligible only
when the account is active, has an active assignment to the sender's service,
owns an active device, and explicitly opted that device into that service.

## Deployment and migration

Apply `AddNotificationPlatform20261013000000` before enabling the worker. With
`RUN_MIGRATIONS=true`, application startup applies it automatically. The `down`
migration drops only Notification tables in dependency order; taking it down
deletes Notification history and is destructive recovery.

```dotenv
NOTIFICATIONS_ENABLED=true
NOTIFICATION_TOKEN_ENCRYPTION_KEY=<32-byte base64url or 64-character hex>
NOTIFICATION_POLL_INTERVAL_MS=1000
NOTIFICATION_RETENTION_INTERVAL_MS=3600000
FIREBASE_PROJECT_ID=<noti-dev-or-prod-project-id>
FIREBASE_CLIENT_EMAIL=<firebase-service-account-email>
FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
```

Use the Noti Dev Firebase service account only in local/dev Auth and Noti Prod
only in production Auth. `NOTIFICATIONS_ENABLED=false` is the credential-free
provider seam: APIs and persistence remain testable while no provider call runs.
Production still requires the token encryption key even when delivery is
disabled; enabling delivery additionally validates all Firebase values.

## Noti OIDC contract

Create service `notification` with public client `notification-app`, grant types
`authorization_code` and `refresh_token`, S256 PKCE required, no client secret,
and audience `service:notification` on access tokens.

| environment | callback URI | bundle/application ID |
| --- | --- | --- |
| dev | `xyz.lafamila.not.dev:/oauth/callback` | `xyz.lafamila.not.dev` |
| prod | `xyz.lafamila.not:/oauth/callback` | `xyz.lafamila.not` |

See
[`examples/notification-service-onboarding-create.json`](./examples/notification-service-onboarding-create.json).

## Noti app API

Every route requires `Authorization: Bearer <access-token>` with issuer/signature,
expiry, audience, service claim, account status and assignment validated.

```http
POST /api/notifications/devices
Content-Type: application/json

{
  "installationId": "stable-os-installation-id",
  "displayName": "Lafa's iPhone",
  "platform": "ios",
  "appVersion": "1.0.0",
  "buildNumber": "42",
  "pushToken": "raw-fcm-registration-token"
}
```

The response contains `id`, display/platform/app metadata, status, availability
and timestamps. It never contains token or fingerprint. Re-registering the same
account/installation rotates the token. Registering a token held by another
device disables that device and revokes its subscriptions (account switching).

- `GET /api/notifications/devices` returns `{ "items": Device[] }`. Each device
  contains `subscriptions` with `serviceKey`, `serviceName`, and `enabled`;
  missing consent rows are represented as `enabled: false`.
- `PATCH /api/notifications/devices/:deviceId` accepts `displayName` and/or
  `active: false`. Reactivation requires a fresh registration with a token.
- `DELETE /api/notifications/devices/:deviceId` returns `204`, clears the token,
  disables/soft-deletes the device and revokes subscriptions.
- `PUT /api/notifications/devices/:deviceId/subscriptions/:serviceKey` accepts
  `{ "enabled": true|false }` and returns `deviceId`, `serviceKey`,
  `serviceName`, consent state and timestamps.
- `PUT /api/notifications/subscriptions/:serviceKey` applies that explicit value
  to all current active devices.
- `GET /api/notifications/inbox?limit=30&cursor=...` returns newest-first
  `{ items, nextCursor }`. Summary rows expose flat `serviceKey`, `serviceName`,
  `title`, and `receivedAt` fields.
- `GET /api/notifications/inbox/:notificationId` returns full body, safe
  metadata, flat sender fields, receive time and a server-verified action with
  `targetKey`, `path`, `uri`, and optional `fallbackUri`.
- `DELETE /api/notifications/inbox/:notificationId` returns `204`; there is no
  restore API.

Cross-account device or inbox IDs return `404` without disclosing ownership.

## Sender API

Both routes authenticate with backend-only headers:

```http
x-auth-service-key-id: asc_location-todo_...
x-auth-service-secret: <backend-only-secret>
```

`GET /api/internal/notification-devices?accountId=<uuid>` requires
`notifications.devices.read` and returns only opaque device ID, display name,
platform and active/available flags for devices opted into the caller.

`POST /api/internal/notifications` requires `notifications.send` and an
`Idempotency-Key` of 1-200 ASCII letters, numbers, `.`, `_`, `:`, or `-`.

```http
POST /api/internal/notifications
Idempotency-Key: location-todo:occurrence:019...
Content-Type: application/json

{
  "accountId": "01900000-0000-4000-8000-000000000001",
  "title": "Arrived near a todo",
  "body": "Buy milk",
  "destination": { "platform": "ios" },
  "action": {
    "targetKey": "location-todo",
    "path": "/notifications/019..."
  },
  "metadata": { "occurrenceId": "019..." }
}
```

`destination` is omitted for all eligible devices, or exactly one of
`{ "deviceIds": ["..."] }` and `{ "platform": "ios"|"android" }`. Every
specified device must belong to the recipient and be opted into the caller.

Accepted response (`201`):

```json
{
  "status": "accepted",
  "notificationId": "019...",
  "accepted": 2,
  "deliveryStatus": "pending",
  "replayed": false
}
```

No eligible destination creates neither inbox nor delivery rows, but persists
the idempotency result:

```json
{
  "status": "no_destinations",
  "notificationId": null,
  "accepted": 0,
  "deliveryStatus": "not_created",
  "replayed": false
}
```

The same `(caller service, Idempotency-Key)` and canonical payload returns the
stored result with `replayed: true` for seven days. A different payload returns
`409 idempotency_payload_conflict`. Metadata permits at most 20 scalar/null
entries and 4096 serialized bytes. Title is limited to 160 characters and body
to 4000.

## Action targets

Senders provide only `targetKey` and path. Approved targets provide a
credential-free HTTPS origin/fallback and optional custom-scheme allowlist. Paths
must begin with one `/`, and contain no query, fragment, backslash or decoded
dot segments. Patterns are exact paths or a trailing `/**` subtree such as
`/notifications/**`. Full sender URLs and open redirects are rejected.

Onboarding omission preserves targets. An explicit array replaces the approved
set; omitted prior targets are disabled, and an empty array disables all.
Admins may enable/disable approved targets but cannot edit URLs or path rules
outside a new onboarding update.

## Errors and retry ownership

| HTTP | meaning |
| --- | --- |
| `400` | DTO/payload/destination shape, metadata or idempotency key invalid |
| `401` | bearer or service credential missing/invalid/disabled/expired |
| `403` | scope, recipient, destination or action not allowed; idempotency header missing |
| `404` | caller-owned app resource not found |
| `409` | idempotency conflict or invalid device reactivation |

Auth accepts first, then owns FCM delivery. Transient failures retry after
`1m, 5m, 15m, 1h, 6h`; a sixth failed attempt becomes `retry_exhausted`.
Unregistered/sender-mismatched tokens are terminal and immediately disable the
device. Sender systems retry only the Auth handoff with the same idempotency key.
FCM data contains only `notificationId`; clients fetch detail from Auth before
using any action.

Retention is 90 days for inbox messages and disabled devices, 30 days for
provider attempts, and seven days for idempotency records. Account hard deletion
cascades through every Notification row.
