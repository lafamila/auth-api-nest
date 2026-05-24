# Service Integration Contract

Services integrate with Teddy Auth as an OIDC relying party.

## Required Inputs

- Discovery URL: `https://auth.lafamila.xyz/.well-known/openid-configuration`
- Issuer: `https://auth.lafamila.xyz`
- JWKS URI from discovery.
- Audience: `service:{serviceKey}` for access tokens.

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

`visitor` is the default permission for every account-service pair. Services should treat it as a no-access or application-required state unless their domain explicitly supports visitor behavior.

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

## Example Token Validation Checklist

1. Fetch discovery metadata.
2. Fetch JWKS and cache by `kid`.
3. Verify signature, issuer, expiration, and audience.
4. Read `https://lafamila.xyz/claims/service`.
5. Reject if claim key does not match the current service.
