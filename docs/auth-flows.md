# Auth Flows

## Authorization Code + PKCE

1. Service redirects the browser to `/oauth/authorize` with `response_type=code`, `client_id`, exact `redirect_uri`, `scope=openid profile email service.permission`, `state`, `code_challenge`, and `code_challenge_method=S256`.
2. Auth server requires an active `tas_session` cookie. Use `POST /login` with `loginId` and `password` to establish that cookie.
3. Auth server validates the OIDC client, exact redirect URI, PKCE, account status, and active account-service permission.
4. Auth server redirects back to the service with either `code` or a standard OAuth `error`.
5. Service exchanges the code at `POST /oauth/token` with `grant_type=authorization_code`, `client_id`, optional `client_secret`, `redirect_uri`, and `code_verifier`.

## Refresh Token Rotation

`POST /oauth/token` with `grant_type=refresh_token` consumes the current refresh token and returns a new access token plus a rotated refresh token. Reusing an already used refresh token revokes the family and fails the request.

## Token Lifetimes

- Authorization code: 1 minute
- Access token: 15 minutes
- Refresh token: 7 days
- Auth session cookie: 12 hours in Phase 1
