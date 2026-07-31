import type { Db } from "../db";
import { newId, nowIso } from "../lib/ids";

export type AuditActorType = "agent" | "human" | "system" | "stripe";

export type AuditInput = {
  aggregateType: string;
  aggregateId?: string | null;
  organizationId?: string | null;
  eventType: string;
  actorType: AuditActorType;
  actorSubject?: string | null;
  requestId?: string | null;
  payload: Record<string, unknown>;
};

export function writeAudit(db: Db, input: AuditInput): string {
  const id = newId("aud");
  db.prepare(
    `INSERT INTO audit_events (
      id, aggregate_type, aggregate_id, organization_id, event_type,
      actor_type, actor_subject, request_id, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.aggregateType,
    input.aggregateId ?? null,
    input.organizationId ?? null,
    input.eventType,
    input.actorType,
    input.actorSubject ?? null,
    input.requestId ?? null,
    JSON.stringify(input.payload),
    nowIso(),
  );
  return id;
}

export type AuditRow = {
  id: string;
  aggregate_type: string;
  aggregate_id: string | null;
  organization_id: string | null;
  event_type: string;
  actor_type: AuditActorType;
  actor_subject: string | null;
  request_id: string | null;
  payload_json: string;
  created_at: string;
};

export function listAuditForOrg(
  db: Db,
  organizationId: string,
  limit = 100,
): AuditRow[] {
  return db
    .prepare(
      `SELECT * FROM audit_events
       WHERE organization_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(organizationId, limit) as AuditRow[];
}
