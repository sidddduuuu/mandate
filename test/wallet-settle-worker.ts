import { parentPort, workerData } from "node:worker_threads";

import { openDatabase } from "../src/db.ts";
import { ApiError } from "../src/http.ts";
import { settleOrderFromWallet } from "../src/payments/wallet.ts";

const input = workerData as Readonly<{
  databasePath: string;
  orderId: string;
  requestId: string;
  now: string;
}>;
const port = parentPort;
if (!port) throw new Error("Wallet worker requires a parent port");

port.once("message", async () => {
  const database = openDatabase(input.databasePath);
  try {
    await settleOrderFromWallet(
      database,
      input.orderId,
      input.requestId,
      new Date(input.now),
    );
    port.postMessage({ outcome: "paid" });
  } catch (error) {
    port.postMessage({
      code: error instanceof ApiError ? error.code : "INTERNAL_ERROR",
    });
  } finally {
    await database.close();
    port.close();
  }
});
port.postMessage({ ready: true });
