"use client";

import { useState } from "react";

type Status = "review" | "payment" | "paid" | "rejected";

const baseEvents = [
  {
    time: "14:02:11",
    title: "Agent identity verified",
    actor: "Auth0",
    detail: "org_ju4 · inventory-agent-prod · orders:create",
  },
  {
    time: "14:02:12",
    title: "Eligible offers compared",
    actor: "Mandate",
    detail: "3 offers · exact unit match · sufficient stock",
  },
  {
    time: "14:02:12",
    title: "Human approval requested",
    actor: "Policy M-104 v7",
    detail: "ORDER_LIMIT_EXCEEDED · PERIOD_BUDGET_EXCEEDED",
  },
] as const;

const statusCopy: Record<Status, { label: string; description: string }> = {
  review: {
    label: "Human approval required",
    description: "$134 beyond this agent’s autonomous authority.",
  },
  payment: {
    label: "Approved · payment pending",
    description: "Waiting for a signed Stripe webhook.",
  },
  paid: {
    label: "Paid",
    description: "Stripe confirmed the exact approved order.",
  },
  rejected: {
    label: "Rejected",
    description: "The order is closed and its budget hold was released.",
  },
};

export function ApprovalDemo() {
  const [status, setStatus] = useState<Status>("review");
  const [note, setNote] = useState("");
  const [decisionNote, setDecisionNote] = useState("");

  const decide = (nextStatus: "payment" | "rejected") => {
    setDecisionNote(note.trim());
    setStatus(nextStatus);
  };

  const reset = () => {
    setStatus("review");
    setNote("");
    setDecisionNote("");
  };

  const events = [
    ...baseEvents,
    ...(status === "payment" || status === "paid"
      ? [
          {
            time: "14:03:04",
            title: "Purchase approved",
            actor: "Maya Chen · Procurement lead",
            detail: decisionNote || "Approved against the frozen order snapshot",
          },
          {
            time: "14:03:05",
            title: "PaymentIntent created",
            actor: "Stripe test mode",
            detail: "pi_3Mandate2048 · $384.00 USD",
          },
        ]
      : []),
    ...(status === "paid"
      ? [
          {
            time: "14:03:06",
            title: "Signed webhook verified · order paid",
            actor: "Mandate webhook",
            detail: "payment_intent.succeeded · evt_mandate_2048",
          },
        ]
      : []),
    ...(status === "rejected"
      ? [
          {
            time: "14:03:04",
            title: "Purchase rejected",
            actor: "Maya Chen · Procurement lead",
            detail: decisionNote || "Rejected by authorized approver",
          },
        ]
      : []),
  ];

  return (
    <>
      <section className="approval-section" id="request">
        <div className="section-bar frame">
          <span>04/</span>
          <span>Approval desk</span>
        </div>

        <div className="approval-intro frame">
          <h2>
            A verified restaurant agent wants{" "}
            <span>18 cases of avocados</span> from{" "}
            <span>Greenline Produce</span> for <span>$384.</span>
          </h2>
        </div>

        <div className="approval-shell frame">
          <div className="request-column">
            <div className="request-heading">
              <div>
                <p className="screen-label">REQ-2048 · requested 2 minutes ago</p>
                <h3>Hass avocados</h3>
              </div>
              <div className={`request-status status-${status}`}>
                <span className="status-dot" aria-hidden="true">
                  ●
                </span>
                {statusCopy[status].label}
              </div>
            </div>

            <dl className="request-facts">
              <div>
                <dt>Requester</dt>
                <dd>inventory-agent-prod</dd>
              </div>
              <div>
                <dt>Representing</dt>
                <dd>Juniper Table Group</dd>
              </div>
              <div>
                <dt>Quantity</dt>
                <dd>18 cases</dd>
              </div>
              <div>
                <dt>Deliver to</dt>
                <dd>Mission District Kitchen · Today by 5 PM</dd>
              </div>
            </dl>

            <table className="offer-table">
              <caption className="sr-only">Supplier offers</caption>
              <thead>
                <tr className="offer-row offer-head">
                  <th scope="col">Eligible supplier</th>
                  <th scope="col">Total</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                <tr className="offer-row offer-selected">
                  <td>Greenline Produce</td>
                  <td>
                    <strong>$384</strong>
                  </td>
                  <td>Selected · lowest</td>
                </tr>
                <tr className="offer-row">
                  <td>Suncrest Foods</td>
                  <td>
                    <strong>$402</strong>
                  </td>
                  <td>+$18</td>
                </tr>
                <tr className="offer-row">
                  <td>Orchard Market</td>
                  <td>
                    <strong>$414</strong>
                  </td>
                  <td>+$30</td>
                </tr>
              </tbody>
            </table>

            <details className="evidence-details">
              <summary>Why Greenline was selected</summary>
              <p>
                Approved supplier, exact case unit, sufficient advisory stock,
                valid delivery location, USD match, and the lowest total.
              </p>
            </details>
          </div>

          <aside className="decision-column" aria-labelledby="decision-title">
            <div>
              <p className="screen-label">Policy decision · M-104 v7</p>
              <h3 id="decision-title">{statusCopy[status].label}</h3>
              <p className="decision-summary">
                {statusCopy[status].description}
              </p>
            </div>

            <dl className="policy-ledger">
              <div>
                <dt>Order total</dt>
                <dd>$384</dd>
              </div>
              <div>
                <dt>Autonomous limit</dt>
                <dd>$250</dd>
              </div>
              <div>
                <dt>Budget remaining</dt>
                <dd>$220</dd>
              </div>
              <div>
                <dt>Hard exception limit</dt>
                <dd>$1,000</dd>
              </div>
            </dl>

            <section
              className="policy-checks"
              aria-labelledby="policy-evidence-title"
            >
              <h4 className="sr-only" id="policy-evidence-title">
                Policy evidence
              </h4>
              <p>✓ Supplier allowed</p>
              <p>✓ Category allowed</p>
              <p>✓ USD required</p>
              <p>✓ Delivery allowed</p>
              <code>ORDER_LIMIT_EXCEEDED</code>
              <code>PERIOD_BUDGET_EXCEEDED</code>
            </section>

            <div className="decision-actions" aria-live="polite">
              {status === "review" && (
                <>
                  <label htmlFor="decision-note">Decision note · optional</label>
                  <textarea
                    id="decision-note"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Add context for the audit trail"
                    rows={3}
                  />
                  <button
                    className="primary-action"
                    type="button"
                    onClick={() => decide("payment")}
                  >
                    Approve $384 purchase&nbsp; →
                  </button>
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={() => decide("rejected")}
                  >
                    Reject request
                  </button>
                </>
              )}

              {status === "payment" && (
                <>
                  <p className="action-message">
                    Approval is recorded. Payment remains pending until the
                    signed event arrives.
                  </p>
                  <button
                    className="primary-action"
                    type="button"
                    onClick={() => setStatus("paid")}
                  >
                    Simulate verified Stripe webhook&nbsp; →
                  </button>
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={reset}
                  >
                    Reset demo
                  </button>
                </>
              )}

              {(status === "paid" || status === "rejected") && (
                <>
                  <p className="action-message">
                    {status === "paid"
                      ? "The audit trail now includes the verified payment event."
                      : "No PaymentIntent was created."}
                  </p>
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={reset}
                  >
                    Reset demo
                  </button>
                </>
              )}
            </div>
          </aside>
        </div>
      </section>

      <section className="audit-section neutral-section" id="audit">
        <div className="section-bar frame">
          <span>05/</span>
          <span>Audit trail</span>
        </div>

        <div className="audit-content frame">
          <h2>
            Every decision
            <br />
            <span>leaves a receipt.</span>
          </h2>

          <div className="audit-list">
            {events.map((event) => (
              <details
                className="audit-event"
                key={`${event.time}-${event.title}`}
              >
                <summary>
                  <time>{event.time}</time>
                  <strong>{event.title}</strong>
                  <span>{event.actor}</span>
                </summary>
                <p>{event.detail}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
