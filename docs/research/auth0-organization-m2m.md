# Auth0 organization-aware M2M requirements

Research date: 2026-07-30

## Verdict

Use Auth0's organization-aware Client Credentials flow only if the hackathon
tenant is entitled to it. Auth0's current official sources conflict: the
feature page says **B2B Professional, Enterprise, and Enterprise premium**,
while the current pricing comparison lists **Select Enterprise Plans** only
([Auth0: M2M Access for Organizations](https://auth0.com/docs/manage-users/organizations/organizations-for-m2m-applications),
[Auth0: pricing comparison](https://auth0.com/pricing?pm=true)). A plan name
alone is therefore not a reliable gate; the repository also contains no
tenant evidence that resolves the entitlement.

If available, configure every Mandate application/API client grant with
`organization_usage: "require"` and `allow_any_organization: false`, then
associate that client grant only with the organizations it may access. Auth0's
Management API defines `require` as the organization-required enum value and
defaults `allow_any_organization` to false
([Auth0: Create client grant](https://auth0.com/docs/api/management/v2/client-grants/post-client-grants)).

If unavailable, use the fallback in this note: one M2M client per organization
and a server-owned mapping from the validated token's client identity to the
organization. This fallback is a Mandate design inference, not an Auth0
Organizations feature.

## Confirmed Auth0 facts

- Organization-aware M2M is scoped per **application, API, and organization**.
  Auth0 represents the application/API relationship as a client grant and the
  organization relationship as an association to that client grant
  ([Auth0: configure an application for M2M access](https://auth0.com/docs/manage-users/organizations/organizations-for-m2m-applications/configure-your-application-for-m2m-access),
  [Auth0: associate a client grant with an organization](https://auth0.com/docs/api/management/v2/organizations/create-organization-client-grants/)).
- A client grant carries the API audience, client ID, allowed scopes,
  `subject_type`, `organization_usage`, and `allow_any_organization`. For
  Client Credentials, `subject_type` is `client`; Auth0 recommends API access
  policies that require client grants so a grant is the permission ceiling
  ([Auth0: client grants](https://auth0.com/docs/get-started/applications/application-access-to-apis-client-grants)).
- `organization_usage` supports `deny`, `allow`, and `require`.
  `allow_any_organization: true` bypasses explicit organization association
  and Auth0 warns that it should be limited to trusted internal applications
  ([Auth0: configure organization behavior](https://auth0.com/docs/manage-users/organizations/organizations-for-m2m-applications/configure-your-application-for-m2m-access)).
- A client grant must be associated separately for every organization/API
  combination it may use. The Management API operation is
  `POST /api/v2/organizations/{id}/client-grants` with a `grant_id`, and its
  Management API token needs `create:organization_client_grants`
  ([Auth0: associate a client grant with an organization](https://auth0.com/docs/api/management/v2/organizations/create-organization-client-grants/)).
- The Client Credentials token request is form-encoded at
  `POST /oauth/token`. It contains `grant_type=client_credentials`,
  `client_id`, client credentials, the custom API `audience`, and an
  `organization` name or identifier for organization context
  ([Auth0: Client Credentials token endpoint](https://auth0.com/docs/api/authentication/client-credential-flow/get-token)).
- An organization-scoped M2M access token includes `org_id`. Auth0's example
  also includes `iss`, `sub`, `aud`, `iat`, `exp`, `scope`, and the requesting
  client identity
  ([Auth0: work with Organizations tokens](https://auth0.com/docs/manage-users/organizations/using-tokens)).
- The client identity claim depends on the API's token profile: the default
  Auth0 profile uses `azp`, while the RFC 9068 profile uses `client_id`
  ([Auth0: access token profiles](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles)).
- Auth0 requires APIs to validate the JWT, audience, and endpoint scopes and to
  reject an invalid token. For Organizations, the API must additionally
  validate that `org_id` is known and segment access to data by that value
  ([Auth0: validate access tokens](https://auth0.com/docs/secure/tokens/access-tokens/validate-access-tokens),
  [Auth0: validate Organization tokens](https://auth0.com/docs/manage-users/organizations/using-tokens)).

## Mandate configuration

### 1. API and application grants

Register one custom Mandate API audience, select RS256, and set client access
to per-application authorization. Auth0 recommends RS256 and recommends
requiring client grants for API access
([Auth0: signing algorithms](https://auth0.com/docs/get-started/applications/signing-algorithms),
[Auth0: client grants](https://auth0.com/docs/get-started/applications/application-access-to-apis-client-grants)).

Create explicit M2M client grants with the scopes already defined in
[ARCHITECTURE.md](../../ARCHITECTURE.md#agents):

| Client role | Client-grant scopes |
|---|---|
| Buyer agent | `offers:read`, `orders:create`, `orders:read` |
| Supplier agent | `catalog:write`, `orders:read` |

The Management API body for each application/API pair should be:

```json
{
  "client_id": "CLIENT_ID",
  "audience": "MANDATE_API_IDENTIFIER",
  "subject_type": "client",
  "scope": ["ROLE_SPECIFIC_SCOPE"],
  "organization_usage": "require",
  "allow_any_organization": false,
  "allow_all_scopes": false
}
```

These fields and enum values come directly from the
[Create client grant API](https://auth0.com/docs/api/management/v2/client-grants/post-client-grants).
Explicit scopes are the least-privilege ceiling; do not use
`allow_all_scopes`, because it would also authorize scopes added to the API in
the future
([Auth0: client-grant attributes](https://auth0.com/docs/get-started/applications/application-access-to-apis-client-grants)).

Associate the returned grant ID only with the organization that owns that
agent:

```http
POST /api/v2/organizations/{AUTH0_ORG_ID}/client-grants
Authorization: Bearer {MANAGEMENT_API_TOKEN}
Content-Type: application/json

{"grant_id":"CLIENT_GRANT_ID"}
```

Auth0 documents this exact association endpoint and request body
([Auth0: associate a client grant with an organization](https://auth0.com/docs/api/management/v2/organizations/create-organization-client-grants/)).
Do not enable `allow_any_organization`; explicit association is the control
that prevents a valid client from selecting an unrelated organization
([Auth0: organization behavior](https://auth0.com/docs/manage-users/organizations/organizations-for-m2m-applications/configure-your-application-for-m2m-access)).

### 2. Token request

Use the immutable Auth0 organization ID, not its display name, as the
`organization` parameter:

```bash
curl --request POST \
  --url 'https://TENANT_DOMAIN/oauth/token' \
  --header 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode 'client_id=CLIENT_ID' \
  --data-urlencode 'client_secret=CLIENT_SECRET' \
  --data-urlencode 'audience=MANDATE_API_IDENTIFIER' \
  --data-urlencode 'organization=AUTH0_ORG_ID'
```

The endpoint, encoding, and parameters are defined by Auth0's
[Client Credentials token endpoint](https://auth0.com/docs/api/authentication/client-credential-flow/get-token).
Auth0 prefers organization IDs for validation. When organization names are
enabled in the Authentication API, tokens add an `org_name` claim that must
also be validated
([Auth0: work with Organizations tokens](https://auth0.com/docs/manage-users/organizations/using-tokens)).

The API must expect a validated payload equivalent to:

```json
{
  "iss": "https://TENANT_DOMAIN/",
  "sub": "CLIENT_ID@clients",
  "aud": "MANDATE_API_IDENTIFIER",
  "exp": 0,
  "scope": "orders:create orders:read",
  "org_id": "org_...",
  "azp": "CLIENT_ID"
}
```

`azp` above assumes the default Auth0 token profile. With RFC 9068, expect
`client_id` instead; `gty` is not present in the RFC 9068 profile
([Auth0: access token profiles](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles)).

### 3. API validation contract

Create the immutable Mandate actor context only after all of these checks pass:

1. Verify the JWT signature with a maintained library, pin RS256, and resolve
   the signing key from the tenant JWKS. Auth0 recommends library/middleware
   validation and publishes keys at
   `https://{yourDomain}/.well-known/jwks.json`
   ([Auth0: validate JWTs](https://auth0.com/docs/secure/tokens/json-web-tokens/validate-json-web-tokens)).
2. Require the configured issuer, the Mandate API audience, and an unexpired
   token. Auth0 treats failed standard JWT or audience checks as an invalid
   token
   ([Auth0: validate access tokens](https://auth0.com/docs/secure/tokens/access-tokens/validate-access-tokens)).
3. Require the route's scope from the space-separated `scope` claim. Auth0
   requires the API to reject a request whose token lacks the endpoint's
   permission
   ([Auth0: validate access-token scopes](https://auth0.com/docs/secure/tokens/access-tokens/validate-access-tokens)).
4. Require `org_id`, require an exact match in Mandate's seeded organization
   table, and scope every read and write by the resulting internal
   organization ID. Auth0 explicitly requires both the known-organization
   check and data segmentation
   ([Auth0: validate Organization tokens](https://auth0.com/docs/manage-users/organizations/using-tokens)).
5. Read the client identity from exactly the configured token profile
   (`azp` for Auth0, `client_id` for RFC 9068), then map it to the expected
   buyer or supplier actor. Auth0 defines both claims as the client ID of the
   requesting application
   ([Auth0: token profile claims](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles)).
6. If `org_name` is present, validate that it corresponds to the same trusted
   `org_id`; otherwise reject it. Auth0 requires the additional validation
   when organization names are enabled
   ([Auth0: validate Organization names](https://auth0.com/docs/manage-users/organizations/using-tokens)).

Never accept a request-body or query-string organization as authoritative.
That is the Mandate-side consequence of Auth0's requirement to authorize and
segment resources by the token's `org_id`
([Auth0: M2M organization isolation](https://auth0.com/docs/manage-users/organizations/organizations-for-m2m-applications)).

## Secure fallback when organization-aware M2M is unavailable

This section is an **implementation recommendation inferred from Auth0's
documented token semantics**, not a claim that Auth0 provides organization
enforcement on an ineligible plan.

1. Create one confidential M2M application per organization and grant it only
   that actor's Mandate API scopes. Client Credentials authenticates the
   application itself, and its client grant defines the permissions returned
   in the token
   ([Auth0: Client Credentials flow](https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-credentials-flow),
   [Auth0: client-grant permissions](https://auth0.com/docs/get-started/applications/application-access-to-apis-client-grants)).
2. Do not send `organization` to `/oauth/token`, and do not expect `org_id`.
   Instead, after full JWT validation, read `azp` or `client_id` according to
   the configured token profile and look it up in a server-owned,
   one-to-one `client_id -> internal_organization_id` configuration
   ([Auth0: access token profiles](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles)).
3. Reject an unmapped client and reject configuration that maps one fallback
   client to multiple organizations. Never take the organization from the
   request. These are Mandate fail-closed rules needed because the fallback
   has no Auth0-issued organization context.
4. Keep each client's credential separate and rotate only that client if it is
   exposed. Client Secret is Auth0's default M2M authentication method; Auth0
   documents secret rotation and recommends Private Key JWT for a stronger
   credential, but Private Key JWT itself requires Enterprise
   ([Auth0: application credentials](https://auth0.com/docs/secure/application-credentials),
   [Auth0: rotate client secrets](https://auth0.com/docs/get-started/applications/rotate-client-secret)).

The fallback preserves deterministic tenant attribution for the demo, but
Auth0 no longer enforces the organization association. It therefore must not
use a shared client across organizations, and it does not replace the separate
tenant check for organization-aware human login.

## Remaining tenant check

No repository evidence establishes the Auth0 tenant's subscription or enabled
features, and Auth0's feature page and pricing matrix currently disagree on
plan availability
([Auth0: feature availability](https://auth0.com/docs/manage-users/organizations/organizations-for-m2m-applications),
[Auth0: pricing comparison](https://auth0.com/pricing?pm=true)). Before
implementation, a tenant administrator must run this gate:

1. Confirm the Dashboard exposes **Organization Support = Required** and
   **Allow machine-to-machine access to any organization** for the
   application/API client grant, plus the organization's **Machine-to-Machine
   Access** association UI. Those are the controls Auth0 documents for the
   feature
   ([Auth0: configure M2M organization access](https://auth0.com/docs/manage-users/organizations/organizations-for-m2m-applications/configure-your-application-for-m2m-access)).
2. Configure one disposable client grant with `organization_usage: "require"`
   and `allow_any_organization: false`, associate it with one disposable
   organization, and request a token for that organization.
3. Verify the allowed request returns a signed access token whose `org_id`
   exactly matches the requested organization. Then verify both an omitted
   `organization` and an unassociated organization are rejected. Required
   organization usage and explicit association are the documented controls
   being tested
   ([Auth0: organization behavior](https://auth0.com/docs/manage-users/organizations/organizations-for-m2m-applications/configure-your-application-for-m2m-access),
   [Auth0: M2M access for Organizations](https://auth0.com/docs/manage-users/organizations/organizations-for-m2m-applications)).
4. Record the API token profile (`Auth0` or `RFC 9068`) so Mandate validates
   one client identity claim, not an ambiguous fallback between `azp` and
   `client_id`
   ([Auth0: access token profiles](https://auth0.com/docs/secure/tokens/access-tokens/access-token-profiles)).

**Go** with organization-aware M2M only if all four checks pass. Otherwise,
use the one-client-per-organization fallback for agents and separately confirm
that the tenant still supports the organization-aware human flow required by
the architecture.
