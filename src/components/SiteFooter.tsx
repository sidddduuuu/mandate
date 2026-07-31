import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <Link className="brand" href="/">
        Mandate
      </Link>
      <p>Governed commerce for AI agents. Auth0 identity · Stripe payments · human approval.</p>
    </footer>
  );
}
