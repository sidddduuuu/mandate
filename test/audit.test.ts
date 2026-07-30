import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { closeDb } from "../src/db";
import { writeAudit } from "../src/audit/audit";
import { setupFixture } from "./helpers";

describe("audit_events", () => {
  it("rejects updates and deletes", () => {
    closeDb();
    const fx = setupFixture(`audit-${randomUUID()}`);
    const id = writeAudit(fx.db, {
      aggregateType: "test",
      eventType: "test.event",
      actorType: "system",
      payload: { ok: true },
    });

    assert.throws(() => {
      fx.db.prepare(`UPDATE audit_events SET event_type = 'x' WHERE id = ?`).run(id);
    });
    assert.throws(() => {
      fx.db.prepare(`DELETE FROM audit_events WHERE id = ?`).run(id);
    });
  });
});
