# Exact Account Directory Lookup

`GET /api/internal/service-accounts/search` accepts optional `exactMatch=loginId|name` alongside `serviceKey` and `q`. Existing callers that omit `exactMatch` keep substring search behavior.

The caller needs its own active service credential with `account.search`. `serviceKey` must match that credential. Exact lookup is case-insensitive, excludes disabled accounts, and returns at most 20 exact matches. An empty exact query returns no accounts. It can find accounts without any assignment for the caller's service; the returned permission overlay is `visitor` in that case. Searching does not create permission assignments.

```http
GET /api/internal/service-accounts/search?serviceKey=chat&q=teddy&exactMatch=loginId
x-auth-service-key-id: <chat credential key id>
x-auth-service-secret: <chat credential secret>
```

The response keeps the existing service-account result shape for backward compatibility. A chat server must project only `id`, `loginId` and `name` to clients, and must independently enforce blocking/friendship rules. Do not forward email, superadmin flags, permission metadata or the service credential to a chat client.

`chat-api-nest` is the first exact-directory consumer. Register its own `chat` service credential through normal onboarding; it does not reuse game/Todo credentials or directly access the auth database.

Social-only accounts have `loginId: null`. Name lookup can return those accounts;
`exactMatch=loginId` matches only real local IDs. Consumers must retain UUID/name
results without fabricating login credentials or converting null to the string
`"None"`. `preferred_username` on tokens is only a display alias and can be email;
use `https://lafamila.xyz/claims/local_login_id` for the actual nullable local ID.
Chat caches that value as nullable, while Todo keeps its legacy empty-string
directory response. See [social login](./social-login.md) for rollout order.
