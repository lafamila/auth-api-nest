# Provider Event Receipts

Inbound provider notifications are separate from Auth's outbound permission
webhooks. They never fetch provider profiles or match an email address. This
module does not implement signup consent, Google Analytics consent, provider
review submission, console registration, or legal acceptance on an operator's
behalf.

## Integration

Import `ProviderEventsModule` into the application and add `ProviderEventEntity`
to the central `AUTH_ENTITIES` list. Apply
`AddProviderEvents20261118000001` before exposing the callbacks. The module
exports `ProviderEventsService` and imports `AccountLifecycleModule`.

`AccountLifecycleService.consumeProviderEvent(provider, clientId, subject, kind)`
is the existing integration contract. Delivery to that method is at least once;
it must tolerate a crash after its transaction commits but before the receipt
is marked processed. No lifecycle work is awaited in the HTTP handler.

The module itself registers Express's text parser only for POST
`/oauth/events/google`, accepting `application/secevent+jwt`, up to 64 KiB.
No `main.ts` parser change is necessary. Default Express form parsing supplies
the Naver/Kakao forms. JSON and text/plain substitutions fail closed.

## Required Environment

New variables, read through `ConfigService` inside this module:

| Variable                       | Default   | Meaning                                                                                                  |
| ------------------------------ | --------- | -------------------------------------------------------------------------------------------------------- |
| `SOCIAL_KAKAO_ADMIN_KEY`       | empty/off | Primary admin key used in the legacy unlink callback's Authorization header. Not the REST client secret. |
| `SOCIAL_KAKAO_APP_ID`          | empty/off | Numeric application ID, not the REST API/client ID.                                                      |
| `SOCIAL_GOOGLE_EVENTS_ENABLED` | `false`   | Only literal `true` permits Google receipts, after manual RISC setup and terms review.                   |

Existing variables are reused through `AppConfigService`:

- `SOCIAL_NAVER_CLIENT_ID` and `SOCIAL_NAVER_CLIENT_SECRET`: both required for
  Naver; absent values keep it off (404).
- `SOCIAL_KAKAO_CLIENT_ID`: central app's REST/client ID, used to scope the
  stored social identity. The app ID/admin key above must belong to this app.
- `SOCIAL_GOOGLE_CLIENT_ID` and `SOCIAL_GOOGLE_CLIENT_SECRET`: same existing
  Google sign-in credentials; both required and client ID must have the
  `.apps.googleusercontent.com` form. Verification never sends the secret.
- `ADMIN_OTP_ENCRYPTION_KEY`: existing stable, secret deployment key. The
  existing AES-GCM service encrypts receipt targets and a namespaced HMAC
  protects indexed dedup identifiers. Do not rotate it while receipts are
  pending; rotation requires the same care as existing MFA/signing secrets.
  Production receipt writes fail closed (503) if this is absent, the known
  development default, or shorter than 32 characters. Use a random 32-byte key
  encoded as 64 hex or base64url, consistent with the existing AES service.
- `NODE_ENV=test`: disables the interval worker; tests call `processOnce()`.

There is no new provider URL, JWKS URL, issuer, retention, or worker-enable env.
Do not log request bodies, Authorization headers, URL query strings, subjects,
SETs or arbitrary provider/DB exceptions in app/proxy/APM access logs. This
module only emits constant queue status messages.

## Protocols And Manual Setup

### Naver

Register the HTTPS URL `${ISSUER_URL}/oauth/events/naver` as the app's
connection-disconnect callback. POST only, Content-Type
`application/x-www-form-urlencoded`, scalar string fields `clientId`,
`encryptUniqueId`, `timestamp`, `signature`; valid durable receipt returns
empty HTTP 204. Naver does not retry failed requests, so monitor DB availability
and keep this path fast. Failed authentication is never ACKed as successful.

Naver protocol details:

- AES key and HMAC key are the 16 **raw bytes** of `MD5(UTF8(clientSecret))`,
  not the hex digest characters.
- Decode unpadded base64url `encryptUniqueId`; first 16 bytes are the random IV,
  remainder is AES-128-CBC with PKCS5/PKCS7 padding.
- HMAC-SHA256 input is exactly
  `clientId={decoded clientId}&encryptUniqueId={decoded encryptUniqueId}&timestamp={decoded timestamp}`.
  No parameter reordering, second percent-encoding, or JWT interpretation.
- Compare the 32 decoded signature bytes in constant time before decrypting.
  Timestamp is integer epoch seconds, younger than 23h59m, at most 60 seconds
  ahead. Reserving that skew inside the 24h receipt lifetime prevents a future
  timestamp from reopening a replay gap after dedup purge. Client ID must equal
  the currently configured Naver app.

The fixed synthetic vector in `provider-events.verifier.spec.ts` is also
checked with independent OpenSSL AES/HMAC commands, including raw MD5 key and
IV-prefix handling. [Naver official guide, section 4.4](https://developers.naver.com/docs/login/devguide/devguide.md#44-네이버-로그인-연결-끊기-알림-받기).

### Kakao

Register `${ISSUER_URL}/oauth/events/kakao` as the **legacy connection unlink
webhook**, with GET or form POST. This is not Kakao's newer account-state SET
webhook, which has different consent, authentication, and ACK rules. HTTPS is
required. Valid authenticated durable receipts return empty HTTP 200; no
account work is awaited, preserving the provider's three-second ACK budget.

Authorization must equal `KakaoAK ${SOCIAL_KAKAO_ADMIN_KEY}` using constant-time
digest comparison. Scalar `app_id` must match `SOCIAL_KAKAO_APP_ID`; `user_id`
must be a canonical positive signed-int64 decimal string (no numeric coercion).
Only `ACCOUNT_DELETE`, `FORCED_ACCOUNT_DELETE`, `UNLINK_FROM_ADMIN`,
`UNLINK_FROM_APPS`, and `INCOMPLETE_SIGN_UP` are accepted referrers. No groups,
email fields, or extra request data are retained.

This official callback has **no timestamp or event ID**. Its authenticated
`(app_id, user_id, referrer_type)` tuple is deduplicated for 24 hours **within
the current local social-identity row ID (link generation)**. One local identity
lookup occurs after authentication, before inserting the receipt; the generation
is included only in the HMAC input, never stored in clear in the receipt. A real
unlink after a new local link therefore does not collide with the previous
link's receipt. A repeat after expiry, or a delayed old callback after a new
link, cannot be distinguished cryptographically from a new unlink.
Never claim signed freshness or indefinite anti-replay for this legacy
protocol; keep the admin key secret. [Kakao official unlink webhook](https://developers.kakao.com/docs/ko/kakaologin/callback#unlink).

### Google RISC

Keep `SOCIAL_GOOGLE_EVENTS_ENABLED=false` until the operator has reviewed and
accepted applicable Google API/RISC terms, enabled the RISC API in the same
Cloud project as sign-in, prepared the RISC Configuration Admin role, and
registered an HTTPS push stream to `${ISSUER_URL}/oauth/events/google` using
Google's administrative setup procedure. No service-account key is needed by
this receiver, and it never invokes registration/admin APIs itself.

The callback returns empty HTTP 202 after its durable receipt. It verifies
RS256 and `kid` using Node JWK import and the existing `jsonwebtoken` package.
Header `typ` must be `secevent+jwt` or `application/secevent+jwt`; key/URL
override and critical headers are rejected. Fixed trusted values, checked
against public discovery on 2026-11-18:

- Envelope issuer: the pinned Google issuer `https://accounts.google.com` or its documented trailing-slash form. No other issuer is accepted.
- JWKS URL: exactly `https://www.googleapis.com/oauth2/v3/certs`.
- Fetches reject redirects, time out after two seconds and cap the JWKS at
  64 KiB/20 keys; only signing RSA/RS256 keys of at least 2048 bits are used.
  Cache-Control max-age is bounded to 60-3600 seconds. Concurrent refreshes
  share a promise; unknown kids cannot force more than one fetch per 30 seconds.
  A failed JWKS refresh remains retryable HTTP 503 during that cooldown; it is
  not converted to an authentication failure. Invalid SETs receive HTTP 400
  with constant `err`/`description` fields and `Content-Language: en`, following
  [the SET delivery error protocol](https://www.rfc-editor.org/rfc/rfc8935.html#section-2.3).
- Audience must contain the current configured Google client ID. `iat` and
  nonempty `jti` are required. Receipt age is locally bounded to under 23h59m
  and future skew to 60 seconds; delayed events outside that policy are
  rejected. This is a local anti-replay/retention bound, not Google's expiry
  rule. Historical SETs do not require `exp`; when present, a numeric `exp`
  is not treated as credential expiry, following Google's receiver guidance.
- Supported nested subject types: Google's `iss-sub`, the legacy OpenID
  `iss_sub`, and `id_token_claims`, always requiring a stable `sub` and an
  explicitly allowed Google subject issuer (`https://accounts.google.com`,
  its trailing-slash variant, or `accounts.google.com`). The envelope issuer
  remains exact. Email-only subjects and non-ID email strings are rejected;
  email and top-level user claims never supply a target.

The exact recognized URI allowlist is:

| URI under `https://schemas.openid.net/secevent/risc/event-type/` | Lifecycle kind     |
| ---------------------------------------------------------------- | ------------------ |
| `sessions-revoked`                                               | `sessions_revoked` |
| `account-disabled`                                               | `sessions_revoked` |
| `account-credential-change-required`                             | `sessions_revoked` |

The separately namespaced OAuth event
`https://schemas.openid.net/secevent/oauth/event-type/tokens-revoked` also ends
Auth sessions. It does not silently delete the Auth account or infer a full
account withdrawal. `account-enabled`, `verification` and token-specific
`token-revoked` are authenticated and ACKed without destructive account action.

All other authenticated event URIs, including `verification`, are deduplicated
and ACKed with no account action and no event body/state retained. This
intentionally does **not** turn token revocation into an unlink or accept
arbitrary URI suffix matches.

**Operational limitation:** Google's current supported-events table does not
advertise `consent-revoked` or `account-purged`; the former is not established
as a currently supported Google event by the primary sources reviewed.
Those unadvertised types are not mapped to account deletion. Subscribe only to confirmed provider-supported
types, request a signed verification event, confirm 202 receipts, then enable
actual operational handling. This implementation is not proof of automatic
notification for every Google consent withdrawal or of provider approval.

[Google receiver and stream setup](https://developers.google.com/identity/protocols/risc),
[public RISC discovery](https://accounts.google.com/.well-known/risc-configuration),
[OpenID RISC subject compatibility](https://openid.net/specs/openid-risc-1_0-final.html#section-3.1),
[SET typing](https://www.rfc-editor.org/rfc/rfc8417.html#section-2.3).

## Persistence, Retries And Retention

A single `INSERT ... ON CONFLICT (provider, dedup_hash) DO NOTHING` atomically
commits the receipt and pending work before ACK. The DB unique constraint,
not memory state, fences concurrent deliveries and survives restarts. Naver
uses its authenticated canonical request; Google uses issuer/current audience/
`jti`; Kakao uses the authenticated tuple and local link generation described
above. No raw payload,
access token, mutable email, signature, or plaintext subject is persisted.

Outside tests a one-second worker claims due rows using `FOR UPDATE SKIP LOCKED`
and a two-minute recoverable lease. Failure schedules exponential retries
starting at five seconds, capped at one hour, with no fixed retry-abandon count.
Lease-token conditions prevent a stale worker from finalizing a newer claim.
Success immediately clears the encrypted target. Dedup-only receipts expire
24 hours after receipt and are purged only when processed. **Pending receipts
are deliberately not purged at the TTL**, so an outage cannot silently erase an
already-ACKed revocation. Monitor overdue pending counts without selecting
targets, repair key/DB/lifecycle failures promptly, and review this exceptional
retention against the operator's security/data policy before deployment.

Naver/Google source-age checks prevent an expired old event from becoming fresh
after dedup purge. This guarantee cannot be added to timestamp-less Kakao
callbacks. DB outage before commit cannot be made lossless for a provider that
does not retry; local durable storage after a successful commit is the boundary.

Migration rollback refuses to discard pending receipts and requires a
transaction. Live PostgreSQL migrations/concurrency validation and deployment
remain main-owned; focused tests use no live DB or provider API.

## Focused Verification

```sh
npx jest --runInBand --runTestsByPath \
  src/social/provider-events/provider-events.verifier.spec.ts \
  src/social/provider-events/google-events.verifier.spec.ts \
  src/social/provider-events/provider-events.service.spec.ts \
  src/social/provider-events/provider-events.module.spec.ts \
  src/social/provider-events/provider-events.migration.spec.ts
npx eslint src/social/provider-events/*.ts \
  src/database/entities/provider-event.entity.ts \
  src/database/migrations/20261118000001-AddProviderEvents.ts
```

The HTTP module tests bind an ephemeral loopback listener only. Provider and
database interactions are mocked. `processOnce()` is available for offline
receipt processing tests, and `purgeProcessed()` tests retention independently.
