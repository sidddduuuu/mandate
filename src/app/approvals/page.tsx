import Link from "next/link";
import { newId } from "@/lib/ids";
import { listApprovals } from "@/procurement/orders";
import { decideApprovalAction } from "./actions";
import { getApprovalSession } from "./session";
import styles from "./approvals.module.css";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ result?: string }>;
}) {
  const { db, actor } = await getApprovalSession();
  if (!actor) {
    return (
      <main className={styles.shell}>
        <h1>Approval queue</h1>
        <p>Sign in through your buyer organization to review orders.</p>
        <Link className={styles.primaryLink} href="/">
          Go to sign in
        </Link>
      </main>
    );
  }
  if (!actor.permissions.has("approvals:read")) {
    return (
      <main className={styles.shell}>
        <h1>Approval queue</h1>
        <p role="alert">Your session does not have approval read permission.</p>
      </main>
    );
  }

  const approvals = listApprovals(
    db,
    actor.organizationId,
    newId("approval-page"),
  );
  const supplierNames = new Map(
    (
      db
        .prepare(
          `SELECT id, name FROM organizations
           WHERE kind = 'supplier'`,
        )
        .all() as { id: string; name: string }[]
    ).map((supplier) => [supplier.id, supplier.name]),
  );
  const { result } = await searchParams;

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Buyer controls</p>
          <h1>Approval queue</h1>
          <p>
            {approvals.length} order{approvals.length === 1 ? "" : "s"} awaiting
            a decision
          </p>
        </div>
        <Link href="/">Account</Link>
      </header>

      {result ? (
        <p className={styles.notice} role="status">
          Result: {result.replaceAll("_", " ")}
        </p>
      ) : null}

      {approvals.length === 0 ? (
        <section className={styles.empty} aria-labelledby="empty-title">
          <h2 id="empty-title">Nothing needs approval</h2>
          <p>Expired and completed decisions are removed automatically.</p>
        </section>
      ) : (
        <ol className={styles.queue}>
          {approvals.map((order) => (
            <li className={styles.card} key={order.id}>
              <div className={styles.cardHeader}>
                <div>
                  <p className={styles.status}>Awaiting approval</p>
                  <h2>{order.product_key}</h2>
                  <p className={styles.muted}>
                    Order <code>{order.id}</code>
                  </p>
                </div>
                <p className={styles.amount}>
                  {order.total_minor.toLocaleString()} {order.currency} minor
                  units
                </p>
              </div>

              <dl className={styles.facts}>
                <div>
                  <dt>Supplier</dt>
                  <dd>
                    {supplierNames.get(order.supplier_org_id) ?? "Unknown supplier"}{" "}
                    (<code>{order.supplier_org_id}</code>)
                  </dd>
                </div>
                <div>
                  <dt>Quantity</dt>
                  <dd>
                    {order.quantity} {order.unit}
                  </dd>
                </div>
                <div>
                  <dt>Delivery</dt>
                  <dd>{order.delivery_location_id}</dd>
                </div>
                <div>
                  <dt>Mandate version</dt>
                  <dd>{order.mandate_version}</dd>
                </div>
                <div>
                  <dt>Offer version</dt>
                  <dd>{order.catalog_version}</dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>
                    <time dateTime={order.approval_expires_at ?? undefined}>
                      {order.approval_expires_at
                        ? new Date(order.approval_expires_at).toLocaleString()
                        : "No expiry"}
                    </time>
                  </dd>
                </div>
              </dl>

              <form action={decideApprovalAction} className={styles.form}>
                <input type="hidden" name="order_id" value={order.id} />
                <label htmlFor={`reason-${order.id}`}>Decision note (optional)</label>
                <textarea
                  id={`reason-${order.id}`}
                  name="reason"
                  maxLength={500}
                  rows={2}
                />
                <div className={styles.actions}>
                  <button name="decision" value="approve" type="submit">
                    Approve and pay
                  </button>
                  <button
                    className={styles.secondary}
                    name="decision"
                    value="reject"
                    type="submit"
                  >
                    Reject
                  </button>
                </div>
              </form>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
