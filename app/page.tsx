import { ApprovalDemo } from "./approval-demo";

const controls = [
  ["Identity", "Auth0 proves the agent and organization.", "Verified"],
  ["Eligibility", "Supplier, category, currency, and delivery match.", "Passed"],
  ["Authority", "$250 autonomous order limit.", "Exceeded"],
  ["Exception", "One human approves the exact frozen order.", "Waiting"],
  ["Payment", "Stripe starts only after approval.", "Locked"],
  ["Audit", "Every transition is attributable and append-only.", "Active"],
] as const;

export default function Home() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="hero" id="top">
        <nav className="top-nav frame" aria-label="Primary navigation">
          <a href="#request">Review request</a>
          <span className="nav-dot" aria-hidden="true" />
          <div className="nav-links">
            <a href="#mandate">Mandate</a>
            <a href="#audit">Audit</a>
          </div>
        </nav>

        <div className="hero-message frame">
          <p>Governed commerce for AI agents.</p>
          <a href="#request">1 exception awaiting review&nbsp; →</a>
        </div>

        <div className="hero-bottom">
          <h1 className="wordmark frame">Mandate.</h1>
          <div className="section-bar frame section-bar-dark">
            <span>01/</span>
            <span>Governing layer</span>
          </div>
        </div>
      </header>

      <main id="main">
        <section className="statement-section neutral-section">
          <div className="center-statement frame">
            <p className="support-copy">Agents move at machine speed.</p>
            <h2>
              Give every buyer the authority to act{" "}
              <span>without giving it unlimited authority.</span>
            </h2>
            <a className="text-link" href="#mandate">
              See the active mandate&nbsp; →
            </a>
          </div>
        </section>

        <section className="feature-section" id="mandate">
          <div className="section-bar frame">
            <span>02/</span>
            <span>Live mandate</span>
          </div>

          <div className="feature-frame frame">
            <div className="mandate-screen">
              <div className="screen-rail">
                <p className="screen-brand">MANDATE</p>
                <div>
                  <p className="screen-label">Organization</p>
                  <p>Juniper Table Group</p>
                </div>
                <nav aria-label="Mandate preview">
                  <span className="rail-active">Overview</span>
                  <span>Orders</span>
                  <span>Suppliers</span>
                  <span>Audit</span>
                </nav>
                <p className="screen-foot">Test mode · M-104</p>
              </div>

              <div className="screen-main">
                <div className="screen-topline">
                  <span>Active purchasing mandate</span>
                  <span className="verified">● Verified by Auth0</span>
                </div>

                <div className="screen-agent">
                  <div>
                    <p className="screen-label">Authorized agent</p>
                    <h3>inventory-agent-prod</h3>
                  </div>
                  <div className="screen-amount">
                    <p className="screen-label">Autonomous limit</p>
                    <p>$250</p>
                  </div>
                </div>

                <div className="screen-rule-grid">
                  <div>
                    <p className="screen-label">Categories</p>
                    <p>Produce, dairy, dry goods</p>
                  </div>
                  <div>
                    <p className="screen-label">Suppliers</p>
                    <p>4 approved</p>
                  </div>
                  <div>
                    <p className="screen-label">Period budget</p>
                    <p>$4,780 / $5,000</p>
                  </div>
                  <div>
                    <p className="screen-label">Delivery</p>
                    <p>3 kitchens</p>
                  </div>
                </div>

                <div className="screen-alert">
                  <div>
                    <span className="status-mark" aria-hidden="true">
                      !
                    </span>
                    <div>
                      <p className="screen-label">Exception awaiting review</p>
                      <p>18 cases of Hass avocados · Greenline Produce</p>
                    </div>
                  </div>
                  <strong>$384.00</strong>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="control-section neutral-section">
          <div className="section-bar frame">
            <span>03/</span>
            <span>Control path</span>
          </div>

          <div className="control-content frame">
            <h2>
              The agent can move fast.
              <br />
              <span>The mandate decides how far.</span>
            </h2>

            <ul className="control-list">
              {controls.map(([name, description, state]) => (
                <li className="control-row" key={name}>
                  <strong>{name}</strong>
                  <p>{description}</p>
                  <span className="control-state">{state}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <ApprovalDemo />
      </main>

      <footer className="site-footer">
        <a className="footer-cta frame" href="#request">
          <span>Ready to delegate?</span>
          <span>→ Set a mandate</span>
        </a>

        <ol className="workflow-circles frame" aria-label="Mandate workflow">
          {[
            ["01", "Verify"],
            ["02", "Compare"],
            ["03", "Approve"],
            ["04", "Pay"],
          ].map(([number, label]) => (
            <li className="workflow-item" key={number}>
              <div className="workflow-circle">
                <span>{number}</span>
                <i aria-hidden="true" />
              </div>
              <p>{label}</p>
            </li>
          ))}
        </ol>

        <p className="footer-wordmark frame">Mandate.</p>
        <div className="footer-meta frame">
          <span>Governed commerce for AI agents</span>
          <span>Auth0 · Stripe · Auditable by design</span>
          <span>© 2026 Mandate</span>
        </div>
      </footer>
    </>
  );
}
