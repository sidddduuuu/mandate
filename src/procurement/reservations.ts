import { writeAudit, type AuditActorType } from "../audit/audit";
import type { Db } from "../db";
import { nowIso } from "../lib/ids";

export function releaseBudgetReservation(
  db: Db,
  input: {
    orderId: string;
    buyerOrgId: string;
    reason: string;
    requestId: string;
    actorType: AuditActorType;
    actorSubject?: string;
  },
): boolean {
  const result = db
    .prepare(
      `UPDATE budget_reservations
       SET status = 'released', updated_at = ?
       WHERE order_id = ? AND status = 'held'`,
    )
    .run(nowIso(), input.orderId);
  if (result.changes !== 1) return false;

  writeAudit(db, {
    aggregateType: "budget_reservation",
    aggregateId: input.orderId,
    organizationId: input.buyerOrgId,
    eventType: "budget.released",
    actorType: input.actorType,
    actorSubject: input.actorSubject,
    requestId: input.requestId,
    payload: { order_id: input.orderId, reason: input.reason },
  });
  return true;
}
