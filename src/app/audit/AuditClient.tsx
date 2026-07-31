"use client";

import { useEffect, useState } from "react";
import { apiGet, type AuditEventView } from "@/lib/client-api";
import { formatWhen } from "@/lib/format";

export function AuditClient() {
  const [events, setEvents] = useState<AuditEventView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<{ events: AuditEventView[] }>("/api/audit");
        if (!cancelled) setEvents(data.events);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="alert" role="alert">{error}</div>;
  if (!events) return <p className="muted">Loading audit events…</p>;
  if (events.length === 0) return <p className="empty">No audit events yet.</p>;

  return (
    <div className="detail-block">
      {events.map((ev) => (
        <article key={ev.id} className="audit-item">
          <strong>{ev.event_type}</strong>
          <div className="meta muted">
            {formatWhen(ev.created_at)} · {ev.actor_type}:{ev.actor_subject} · {ev.aggregate_type}/
            <span className="mono">{ev.aggregate_id}</span>
          </div>
          <pre
            className="mono muted"
            style={{
              whiteSpace: "pre-wrap",
              margin: "0.55rem 0 0",
              fontSize: "0.8rem",
              maxHeight: "8rem",
              overflow: "auto",
            }}
          >
            {JSON.stringify(ev.payload, null, 2)}
          </pre>
        </article>
      ))}
    </div>
  );
}
