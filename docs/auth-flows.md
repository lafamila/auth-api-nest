# Auth Flows

## Authorization Code + PKCE

1. Service redirects the browser to `/oauth/authorize` with `response_type=code`, `client_id`, exact `redirect_uri`, `scope=openid profile email service.permission`, `state`, `code_challenge`, and `code_challenge_method=S256`.
2. Auth server requires an active `tas_session` cookie. Use `POST /login` with `loginId` and `password` to establish that cookie.
3. Auth server validates the OIDC client, exact redirect URI, PKCE, account status, and active account-service permission.
4. Auth server redirects back to the service with either `code` or a standard OAuth `error`.
5. Service exchanges the code at `POST /oauth/token` with `grant_type=authorization_code`, `client_id`, optional `client_secret`, `redirect_uri`, and `code_verifier`.

## Native Public Clients

Native apps use public OIDC clients. They do not send or store a client secret.
PKCE is required, and `redirect_uri` must exactly match one registered value.

Supported redirect URI values include normal web URLs and native app callback
schemes. The body-lab clients use:

- `body-lab-ios`: `bodylab://auth/callback`
- `body-lab-mac`: `bodylab-mac://auth/callback`

The token request for these clients must include `client_id`, `code`,
`redirect_uri`, and `code_verifier`, but must omit `client_secret`.

## Refresh Token Rotation

`POST /oauth/token` with `grant_type=refresh_token` consumes the current refresh token and returns a new access token plus a rotated refresh token. Reusing an already used refresh token revokes the family and fails the request.

## Token Lifetimes

- Authorization code: 1 minute
- Access token: 15 minutes
- Refresh token: 7 days
- Auth session cookie: 12 hours in Phase 1
