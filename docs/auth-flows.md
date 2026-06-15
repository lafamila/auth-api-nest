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
- Admin session cookie: idle 30 minutes, absolute 12 hours

## Admin Bootstrap + Login

1. `/admin` calls `GET /api/admin/bootstrap/status`.
2. If there is no active superadmin, the bootstrap page calls `POST /api/admin/bootstrap/start`.
3. The response shows the OTP secret and otpauth URI once so the user can register Google Authenticator.
4. `/api/admin/bootstrap/complete` verifies the OTP code and only then creates the first superadmin.
5. If an active superadmin exists, `/admin` shows login and calls `POST /api/admin/login` with login ID, password, and OTP.
6. Admin APIs require the HttpOnly admin session cookie. `x-admin-key` is not an admin authorization model.

## Signup

1. `/signup` or a service-owned link calls `POST /api/signup/start` with an email.
2. Auth sends a 6-character alphanumeric code by SMTP. Local development may log the code instead.
3. The user completes signup with login ID, name, email, code, and password at `POST /api/signup/complete`.
4. The account receives the default `visitor` permission for every active service.
