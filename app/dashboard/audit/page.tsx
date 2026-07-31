import type { Metadata } from "next";

import { loadDashboardSnapshot } from "../../../src/dashboard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Audit — Mandate" };

export default async function AuditPage() {
  const snapshot = await loadDashboardSnapshot();
  return (
    <>
      <header className="app-page-title">
        <p className="eyebrow">Immutable operations log</p>
        <h1>Audit</h1>
        <p>Auth0 identity, agent decisions, human approvals, and Stripe settlement in one trace.</p>
      </header>
      <section className="app-audit-list" aria-label="Audit events">
        <div className="audit-table-head"><span>Time</span><span>Event</span><span>Actor</span><span>Evidence</span></div>
        {snapshot.events.map((event) => (
          <div className="app-audit-row" key={event.id}>
            <time>{event.time}</time>
            <strong>{event.title}</strong>
            <span>{event.actor}</span>
            <span>{event.detail}</span>
          </div>
        ))}
      </section>
    </>
  );
}
