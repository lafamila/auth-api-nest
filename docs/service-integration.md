# Service Integration Contract

Services integrate with Teddy Auth as an OIDC relying party.

## Required Inputs

- Discovery URL: `https://auth.lafamila.xyz/.well-known/openid-configuration`
- Issuer: `https://auth.lafamila.xyz`
- JWKS URI from discovery.
- Audience: `service:{serviceKey}` for access tokens.

## Service Onboarding Request

New services should prepare a service onboarding request before they expect
central login to work. The request is the service-owned auth spec and can be
submitted to:

```http
POST /api/service-onboarding-requests
Content-Type: application/json
```

The request should include the intended `serviceKey`, display name, permission
definitions, OIDC client specs, redirect URIs, scopes, client type, PKCE choice,
and backend service credential scopes.

There are two ways to create the same request:

1. A service team or deployment agent sends the JSON directly to the public API.
2. A logged-in superadmin uses `/service` to compose the same payload with
   structured fields and a JSON preview.

The `/service` builder also accepts a saved request JSON file by drag-and-drop
or file picker import. Import replaces the full current form state instead of
merging field-by-field.

During import and during submit payload construction, `/service` always rewrites
`requesterName` and `requesterEmail` from the current admin session account. The
imported JSON values for those fields are ignored, and the requester inputs are
read-only in the UI.

Unknown top-level JSON fields are ignored and surfaced as warnings in `/service`
instead of being forwarded to the request API. If the imported permissions array
contains `visitor`, `/service` removes that row and warns because auth manages
the default visitor permission automatically.

If the file is not valid JSON, or if a supported field uses the wrong type
(`permissions`, `oidcClients`, `serviceCredentials`, or nested string/boolean
fields), `/service` keeps the existing form state unchanged and shows an import
error.

Both paths create a pending `service_onboarding_requests` row and use the same
approval lifecycle. The `/service` UI does not bypass the public request
contract.

The `/service` page currently requires the same superadmin session as `/admin`.
If there is no valid admin session, the request form is hidden and the floating
Admin Session control opens bootstrap or login. When developer accounts are
introduced later, `/service` can switch its identity source without changing the
public request API contract.

Auth admins approve or reject the request in `/admin`. Approved core spec fields
are not edited directly inside auth; if the service needs to change redirect
URIs, permission keys, scopes, or client shape, it submits an update request
using the request-update-only `requestSecret` returned by the original request.
That `requestSecret` is not a client secret or service credential secret and
must not be copied into the consuming service's runtime `.env`.

When a pending request is revised with a valid request secret, the previous
pending revision is marked `superseded` and the revised payload becomes the only
pending request for that `serviceKey`.

The approval response may include one-time client or service credential secrets.
The consuming service must store those in backend-only environment variables or
a secret manager. In `/admin`, approval and credential rotation secrets appear
only in a one-time modal with label/value rows, value-only copy buttons, and
concrete `.env` examples containing the actual issued values. Overlay clicks
and copy clicks do not close the modal; only the top close button or bottom
confirmation button clears raw secret values from browser state.
Frontend/browser code must never receive those secrets.

## Permission Claim

Access tokens include a namespaced service permission claim:

```json
{
  "https://lafamila.xyz/claims/service": {
    "key": "todo",
    "permission": "admin",
    "permissionSchemaVersion": 3
  }
}
```

Services map the central permission string to local domain behavior. They must not read the auth database directly.

For server-to-server reads against auth internal APIs, services must use their own service credential pair issued by the auth admin console:

- `x-auth-service-key-id`
- `x-auth-service-secret`

Phase 1 internal endpoint:

```http
GET /api/internal/service-accounts/search?serviceKey={serviceKey}&q={query}
```

Rules:

1. The credential must belong to the same `serviceKey`.
2. The credential must include `account.search`.
3. The raw secret is shown only once at create/rotate time and must be stored by the consuming service, not by this repo.

`visitor` is the default permission state for services, but auth does not pre-create every account-service row. Services should treat both `visitor` and a denied login caused by an existing non-active assignment as no-access or application-required states unless their domain explicitly supports visitor behavior.

When a logged-in user has `visitor`, the service can show an access request form and call:

```http
POST /api/service-applications
Authorization: Bearer {access_token}
Content-Type: application/json

{
  "serviceKey": "todo",
  "message": "I need Todo access for project work."
}
```

The auth server only accepts this request when the token's service claim key matches `serviceKey` and the permission is `visitor`.

On the first successful login to an active service, if the user has no row at all for that service, auth lazily creates `visitor` and issues the token with that claim. If a row already exists in a non-active state, auth denies access instead of auto-restoring it.

## Example Token Validation Checklist

1. Fetch discovery metadata.
2. Fetch JWKS and cache by `kid`.
3. Verify signature, issuer, expiration, and audience.
4. Read `https://lafamila.xyz/claims/service`.
5. Reject if claim key does not match the current service.

## body-lab Integration

body-lab is registered in auth, but the primary OIDC relying party is
`body-lab-api-nest`, not the native apps directly. Native macOS/iOS clients
authenticate through `body-lab-api-nest`, then store only the body-lab opaque
session token they receive back.

Required service registry values:

- serviceKey: `body-lab`
- service name/label: `body-lab`
- permission definition: `owner`
- optional permission definition: `tester`
- default `visitor`: no access in body-lab; the body-lab API must reject it.

Primary OIDC client:

- `body-lab-api`
  - client type: `confidential`
  - client secret: generated once at onboarding approval time
  - require PKCE: `true`
  - redirect URI: `http://localhost:3020/session/oidc/callback`
  - redirect URI: `https://lab.lafamila.xyz/session/oidc/callback`

For physical-device local development, auth admins may add
`http://{LAN_IP}:3020/session/oidc/callback` in a local auth DB only when
`body-lab-api-nest` is actually listening on that LAN address. Do not place a
placeholder LAN URI in the canonical approved spec.

Legacy native public clients:

- `body-lab-ios`
- `body-lab-mac`

Those public clients are deprecated implementation leftovers, not a supported
runtime fallback for current body-lab work. They may still exist in auth during
migration cleanup, but new body-lab integration and testing should treat the
confidential `body-lab-api` flow as the only supported login path.

The primary client uses Authorization Code + PKCE with these scopes:

```text
openid profile email service.permission
```

`body-lab-api-nest` exchanges the authorization code with the confidential
client secret, validates the auth token response, and creates its own opaque
body-lab session. Native apps must not store:

- the auth OIDC client secret
- any auth internal API service credential
- any auth refresh token

Direct native/public-client OIDC login and any body-lab ID/password proxy login
are removed/deprecated for implementation in this architecture.

The body-lab API validates auth access tokens with:

- issuer: `https://auth.lafamila.xyz`
- audience: `service:body-lab`
- service claim key: `body-lab`
- required permission: `owner`

Example body-lab access token claim shape:

```json
{
  "aud": "service:body-lab",
  "scope": "openid profile email service.permission",
  "https://lafamila.xyz/claims/service": {
    "key": "body-lab",
    "permission": "owner",
    "permissionSchemaVersion": 2
  }
}
```

`permissionSchemaVersion` is issued from the auth service registry and may
increase when body-lab permission definitions change. Consumers must not
hardcode the example value.

Onboarding request strategy:

- If auth does not already have the `body-lab` service, submit a create request.
- If auth already has the `body-lab` service, submit an update request instead
  of asking auth admins to edit the approved spec directly.
- `/service` JSON import files must not contain `visitor`; the importer strips
  it because auth manages that permission automatically.
- `/service` JSON import files should not include `requestSecret`; update
  requests send that separately with `x-request-secret` or the body field.
- Imported `requesterName` and `requesterEmail` values are ignored by
  `/service`, which rewrites them from the current admin session.

Import-ready example payload:

- [docs/examples/body-lab-service-onboarding-create.json](/Users/lafamila/work/teddy/auth-api-nest/docs/examples/body-lab-service-onboarding-create.json)

Approved-secret handling:

- The approval modal returns `BODY_LAB_OIDC_CLIENT_SECRET` once. Copy it only
  into `body-lab-api-nest` backend runtime configuration.
- This integration does not require an auth internal service credential in the
  current scope, so do not create or document
  `BODY_LAB_AUTH_SERVICE_KEY_ID` / `BODY_LAB_AUTH_SERVICE_SECRET` for body-lab
  yet.
- If body-lab later adds account search, submit a new onboarding update request
  that adds a service credential with the `account.search` scope.

Consuming repos should map the approved values into their own config names:

- API/backend: auth discovery URL, issuer URL, JWKS URI or discovery-derived
  JWKS URI, audience `service:body-lab`, service key `body-lab`, required
  permission `owner`, `BODY_LAB_OIDC_CLIENT_ID=body-lab-api`,
  `BODY_LAB_OIDC_CLIENT_SECRET`, and the callback base URL used to construct
  `/session/oidc/callback`.
- Native apps: only the body-lab API base URL and the opaque body-lab session
  contract (`X-Body-Lab-Session`). Do not ship auth client secrets or auth
  service credentials in the app bundle.

No body-lab app should embed an auth client secret or auth service credential.
