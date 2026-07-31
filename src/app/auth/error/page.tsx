import Link from "next/link";

type Props = {
  searchParams: Promise<{ code?: string; detail?: string }>;
};

export default async function AuthErrorPage({ searchParams }: Props) {
  const params = await searchParams;
  const code = params.code ?? "authorization_error";
  const detail = params.detail ?? "An error occurred during the authorization flow.";
  const orgHint = process.env.SEED_BUYER_AUTH0_ORG_ID ?? "org_buyer";

  const isOrgNotAllowed = /organization is not allowed/i.test(detail);

  return (
    <main id="main" className="app-shell">
      <header className="app-hero">
        <h1>Sign-in failed</h1>
        <p>{detail}</p>
      </header>

      <div className="alert" role="alert">
        <strong className="mono">{code}</strong>
      </div>

      {isOrgNotAllowed ? (
        <section className="detail-block" style={{ marginTop: "1.5rem" }}>
          <h2>Fix in Auth0 Dashboard</h2>
          <ol>
            <li>
              Open <strong>Applications → your Mandate app → Settings</strong>
            </li>
            <li>
              Scroll to <strong>Organizations</strong>
            </li>
            <li>
              Set <strong>Organization Usage</strong> to{" "}
              <em>Business Users</em> (or <em>Individuals &amp; Business Users</em>) — not{" "}
              <em>Deny</em>
            </li>
            <li>
              Save, then also open <strong>Organizations → your org → Applications</strong> and
              enable this app
            </li>
            <li>Add your user as a member of the organization</li>
          </ol>
        </section>
      ) : null}

      <div className="actions" style={{ marginTop: "1.5rem" }}>
        <a
          className="btn btn-primary"
          href={`/auth/login?organization=${encodeURIComponent(orgHint)}`}
        >
          Try again
        </a>
        <Link className="btn btn-ghost-dark" href="/">
          Back home
        </Link>
      </div>
    </main>
  );
}
