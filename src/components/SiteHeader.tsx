import Link from "next/link";

type Props = {
  signedIn: boolean;
  email: string | null;
  orgId: string | null;
  orgHint: string;
};

export function SiteHeader({ signedIn, email, orgId, orgHint }: Props) {
  const loginHref = `/auth/login?organization=${encodeURIComponent(orgHint)}`;

  return (
    <header className="site-header site-header-dark">
      <Link className="brand" href="/">
        Mandate
      </Link>
      <nav aria-label="Primary">
        <ul className="nav-links">
          {signedIn ? (
            <>
              <li>
                <Link href="/inventory">Inventory</Link>
              </li>
              <li>
                <Link href="/needs">Needs</Link>
              </li>
              <li>
                <Link href="/approvals">Approvals</Link>
              </li>
              <li>
                <Link href="/orders">Orders</Link>
              </li>
              <li>
                <Link href="/deliveries">Deliveries</Link>
              </li>
              <li>
                <Link href="/mandates">Mandates</Link>
              </li>
              <li>
                <Link href="/audit">Audit</Link>
              </li>
            </>
          ) : (
            <>
              <li>
                <Link href="/#how">How it works</Link>
              </li>
              <li>
                <Link href="/approvals">Approvals</Link>
              </li>
              <li>
                <Link href="/mandates">Mandates</Link>
              </li>
              <li>
                <Link href="/orders">Orders</Link>
              </li>
              <li>
                <Link href="/audit">Audit</Link>
              </li>
            </>
          )}
        </ul>
      </nav>
      <div className="header-actions">
        {signedIn ? (
          <>
            <span className="header-user" title={email ?? undefined}>
              {orgId ? orgId : "signed in"}
            </span>
            <a className="btn btn-cream btn-sm" href="/auth/logout">
              Log out
            </a>
          </>
        ) : (
          <a className="btn btn-cream btn-sm" href={loginHref}>
            Store owner login <span className="arrow" aria-hidden>
              →
            </span>
          </a>
        )}
      </div>
    </header>
  );
}
