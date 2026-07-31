# ADR 0002: Auth0 Next.js SDK for human Organization sessions

## Status

Accepted

## Context

Mandate requires Auth0 organization-aware human sessions for mandate writes and
order approvals. The initial backend used a hand-rolled HMAC cookie, which is
fine for tests but does not provide Authorization Code + PKCE, org login, or
token refresh.

The Auth0 agent skill (`auth0/agent-skills`, intent `integrate` +
`feature:organizations`, framework `nextjs`) recommends `@auth0/nextjs-auth0` v4
with middleware-mounted `/auth/*` routes and `organization` on login.

## Decision

- Use `@auth0/nextjs-auth0` for human browser sessions.
- Require `org_id` on the Auth0 session (login via `/auth/login?organization=`).
- Map Auth0 `org_id` to internal organizations; never trust client-supplied tenant IDs.
- Prefer RBAC `permissions` on the Mandate API access token; fall back to
  `AUTH0_DEFAULT_HUMAN_PERMISSIONS` for demos.
- Keep agent authentication as bearer JWT validation (JWKS / test HMAC).
- Keep the HMAC `mandate_session` cookie only when `AUTH_TEST_MODE=1`.

## Consequences

Approvers get a real Auth0 Organization login path without waiting on the
frontend track. Frontend can later replace the stub home-page links with a
designed UI while reusing the same session actor mapping.
