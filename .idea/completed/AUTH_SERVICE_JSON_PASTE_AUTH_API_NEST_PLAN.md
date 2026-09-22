---
status: COMPLETED
summary: 'Allow pasted JSON to populate the /service onboarding form through the existing import path.'
completed_at: 2026-09-22
completion_reason: 'Paste UI, shared import flow, focused tests, isolated browser smoke, lint, build, unit, and e2e verification completed.'
---

# AUTH_SERVICE_JSON_PASTE - auth-api-nest plan

## Scope

- Add a pasted-JSON textarea and import action to `public/service.html`.
- Route file and pasted JSON through the same parser, normalization, validation, and form application path.
- Keep onboarding DTOs, APIs, webhooks, and backend domain behavior unchanged.

## Review Criteria

- Valid pasted JSON produces the same normalized draft as file import.
- Malformed pasted JSON and invalid field shapes show an error without applying a draft.
- Existing file selection and drag/drop import behavior remains available.
- `npm run test -- --runInBand`, `npm run lint`, and `npm run build` pass.
