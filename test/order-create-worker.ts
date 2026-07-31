import { parentPort, workerData } from "node:worker_threads";

import type { ActorContext } from "../src/auth/context.ts";
import { openDatabase } from "../src/db.ts";
import { createOrder } from "../src/procurement/orders.ts";

type WorkerInput = Readonly<{
  databasePath: string;
  idempotencyKey: string;
  requestId: string;
  now: string;
}>;

const input = workerData as WorkerInput;
const actor: ActorContext = Object.freeze({
  organizationId: "org_buyer",
  actorType: "buyer_agent",
  scopes: Object.freeze(["orders:create", "orders:read"]),
  subject: "buyer_agent@test",
});

const port = parentPort;
if (!port) throw new Error("Order worker requires a parent port");

port.once("message", async () => {
  const database = openDatabase(input.databasePath);
  try {
    const result = await createOrder(
      database,
      actor,
      {
        productKey: "hass-avocado",
        unit: "case",
        quantity: 10,
        deliveryLocationId: "kitchen",
      },
      input.idempotencyKey,
      input.requestId,
      new Date(input.now),
    );
    port.postMessage({
      status: result.kind === "order" ? result.order.status : "denied",
    });
  } catch (error) {
    port.postMessage({
      error: error instanceof Error ? error.message : "Unknown worker error",
    });
  } finally {
    await database.close();
    port.close();
  }
});
port.postMessage({ ready: true });
