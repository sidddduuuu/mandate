import { closeDb, getDb, migrate } from "../src/db";
import { expireApprovals } from "../src/procurement/orders";
import { newId } from "../src/lib/ids";

migrate(getDb());
const requestId = newId("reconcile");
const expired = expireApprovals(getDb(), requestId);
console.log(JSON.stringify({ expired_approvals: expired, request_id: requestId }));
closeDb();
