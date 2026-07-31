import { auth0 } from "./auth0-page";

export default async function HomePage() {
  const session = await auth0.getSessionSafe();
  const orgHint = process.env.SEED_BUYER_AUTH0_ORG_ID ?? "org_buyer";

  return (
    <main>
      <h1>Mandate</h1>
      <p>Governed commerce for AI agents — backend APIs under /api/*</p>

      <section>
        <h2>Human approver login (Auth0 Organizations)</h2>
        <p>
          Mandate scopes every approval to an Auth0 <code>org_id</code>. Use the
          Organization-aware login link so the session carries tenant context.
        </p>
        {session?.user ? (
          <div>
            <p>
              Signed in as <strong>{session.user.email ?? session.user.sub}</strong>
              {session.user.org_id ? (
                <>
                  {" "}
                  in org <code>{session.user.org_id}</code>
                </>
              ) : (
                <> (missing org — re-login with organization param)</>
              )}
            </p>
            <p>
              <a href="/api/session">View Mandate actor (/api/session)</a>
              {" · "}
              <a href="/auth/logout">Log out</a>
            </p>
          </div>
        ) : (
          <p>
            <a href={`/auth/login?organization=${encodeURIComponent(orgHint)}`}>
              Log in to buyer organization
            </a>
          </p>
        )}
      </section>
    </main>
  );
}
