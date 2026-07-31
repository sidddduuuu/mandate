import Link from "next/link";

type Props = {
  orgHint: string;
  title?: string;
  message?: string;
};

export function LoginGate({
  orgHint,
  title = "Sign in to continue",
  message = "Sign in as the buyer-organization approver to manage mandates, approvals, and audit.",
}: Props) {
  const loginHref = `/auth/login?organization=${encodeURIComponent(orgHint)}`;
  return (
    <div className="app-shell">
      <div className="app-hero">
        <h1>{title}</h1>
        <p>{message}</p>
        <div className="actions">
          <a className="btn btn-primary" href={loginHref}>
            Continue as approver <span className="arrow" aria-hidden>→</span>
          </a>
          <Link className="btn btn-ghost-dark" href="/">
            Back home
          </Link>
        </div>
      </div>
    </div>
  );
}
