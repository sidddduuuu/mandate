import { createHash } from "crypto";
import { z } from "zod";
import type { Db } from "../db";
import { withImmediateTransaction } from "../db";
import { writeAudit } from "../audit/audit";
import type { ActorContext } from "../auth/context";
import { AppError } from "../lib/http";
import { newId, nowIso } from "../lib/ids";
import { createOrder, type OrderRow } from "../procurement/orders";
import type { StripeAdapter } from "../payments/stripe";

/** Stable UUID so re-placing the same need stays idempotent. */
function idempotencyKeyForNeed(needId: string): string {
  const hex = createHash("sha256").update(`need-order:${needId}`).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export type InventoryItemRow = {
  id: string;
  buyer_org_id: string;
  product_key: string;
  display_name: string;
  category: string;
  unit: string;
  location_id: string;
  on_hand: number;
  reorder_point: number;
  target_quantity: number;
  updated_at: string;
};

export type PurchaseNeedRow = {
  id: string;
  buyer_org_id: string;
  inventory_item_id: string;
  product_key: string;
  unit: string;
  location_id: string;
  suggested_quantity: number;
  reason: string;
  status: "open" | "ordered" | "dismissed";
  order_id: string | null;
  detected_by_subject: string;
  created_at: string;
  updated_at: string;
};

export type DeliveryStatus =
  | "packing"
  | "shipped"
  | "out_for_delivery"
  | "delivered"
  | "cancelled";

export type DeliveryRow = {
  id: string;
  order_id: string;
  buyer_org_id: string;
  supplier_org_id: string;
  product_key: string;
  quantity: number;
  unit: string;
  location_id: string;
  status: DeliveryStatus;
  eta_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  inventory_applied: number;
  created_at: string;
  updated_at: string;
};

const DELIVERY_NEXT: Record<DeliveryStatus, DeliveryStatus | null> = {
  packing: "shipped",
  shipped: "out_for_delivery",
  out_for_delivery: "delivered",
  delivered: null,
  cancelled: null,
};

export function serializeInventoryItem(row: InventoryItemRow) {
  const deficit = Math.max(0, row.reorder_point - row.on_hand);
  return {
    id: row.id,
    product_key: row.product_key,
    display_name: row.display_name,
    category: row.category,
    unit: row.unit,
    location_id: row.location_id,
    on_hand: row.on_hand,
    reorder_point: row.reorder_point,
    target_quantity: row.target_quantity,
    low_stock: row.on_hand <= row.reorder_point,
    suggested_restock: Math.max(0, row.target_quantity - row.on_hand),
    deficit,
    updated_at: row.updated_at,
  };
}

export function serializePurchaseNeed(row: PurchaseNeedRow) {
  return {
    id: row.id,
    inventory_item_id: row.inventory_item_id,
    product_key: row.product_key,
    unit: row.unit,
    location_id: row.location_id,
    suggested_quantity: row.suggested_quantity,
    reason: row.reason,
    status: row.status,
    order_id: row.order_id,
    detected_by_subject: row.detected_by_subject,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function serializeDelivery(row: DeliveryRow) {
  return {
    id: row.id,
    order_id: row.order_id,
    product_key: row.product_key,
    quantity: row.quantity,
    unit: row.unit,
    location_id: row.location_id,
    supplier_org_id: row.supplier_org_id,
    status: row.status,
    eta_at: row.eta_at,
    shipped_at: row.shipped_at,
    delivered_at: row.delivered_at,
    inventory_applied: row.inventory_applied === 1,
    next_status: DELIVERY_NEXT[row.status],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listInventory(db: Db, buyerOrgId: string): InventoryItemRow[] {
  return db
    .prepare(
      `SELECT * FROM inventory_items
       WHERE buyer_org_id = ?
       ORDER BY (on_hand <= reorder_point) DESC, product_key ASC`,
    )
    .all(buyerOrgId) as InventoryItemRow[];
}

export function upsertInventoryItem(
  db: Db,
  buyerOrgId: string,
  input: {
    product_key: string;
    display_name: string;
    category: string;
    unit: string;
    location_id: string;
    on_hand: number;
    reorder_point: number;
    target_quantity: number;
  },
): InventoryItemRow {
  const now = nowIso();
  const existing = db
    .prepare(
      `SELECT * FROM inventory_items
       WHERE buyer_org_id = ? AND product_key = ? AND location_id = ?`,
    )
    .get(buyerOrgId, input.product_key, input.location_id) as InventoryItemRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE inventory_items SET
         display_name = ?, category = ?, unit = ?,
         on_hand = ?, reorder_point = ?, target_quantity = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.display_name,
      input.category,
      input.unit,
      input.on_hand,
      input.reorder_point,
      input.target_quantity,
      now,
      existing.id,
    );
    return db.prepare(`SELECT * FROM inventory_items WHERE id = ?`).get(existing.id) as InventoryItemRow;
  }

  const id = newId("inv");
  db.prepare(
    `INSERT INTO inventory_items (
       id, buyer_org_id, product_key, display_name, category, unit, location_id,
       on_hand, reorder_point, target_quantity, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    buyerOrgId,
    input.product_key,
    input.display_name,
    input.category,
    input.unit,
    input.location_id,
    input.on_hand,
    input.reorder_point,
    input.target_quantity,
    now,
  );
  return db.prepare(`SELECT * FROM inventory_items WHERE id = ?`).get(id) as InventoryItemRow;
}

/** Agent (or demo) scans stock and opens purchase-list lines for low items. */
export function scanInventoryNeeds(
  db: Db,
  actor: ActorContext,
  requestId: string,
): PurchaseNeedRow[] {
  if (actor.actorType !== "agent" && actor.actorType !== "human") {
    throw new AppError(403, "forbidden", "Only store agents or owners can scan inventory");
  }

  return withImmediateTransaction(db, () => {
    const items = listInventory(db, actor.organizationId);
    const created: PurchaseNeedRow[] = [];
    const now = nowIso();

    for (const item of items) {
      if (item.on_hand > item.reorder_point) continue;
      const qty = Math.max(1, item.target_quantity - item.on_hand);
      const open = db
        .prepare(
          `SELECT * FROM purchase_needs
           WHERE buyer_org_id = ? AND inventory_item_id = ? AND status = 'open'`,
        )
        .get(actor.organizationId, item.id) as PurchaseNeedRow | undefined;
      if (open) {
        db.prepare(
          `UPDATE purchase_needs SET
             suggested_quantity = ?, reason = ?, detected_by_subject = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          qty,
          `on_hand ${item.on_hand} ≤ reorder ${item.reorder_point}`,
          actor.subject,
          now,
          open.id,
        );
        created.push(
          db.prepare(`SELECT * FROM purchase_needs WHERE id = ?`).get(open.id) as PurchaseNeedRow,
        );
        continue;
      }

      const id = newId("need");
      db.prepare(
        `INSERT INTO purchase_needs (
           id, buyer_org_id, inventory_item_id, product_key, unit, location_id,
           suggested_quantity, reason, status, order_id, detected_by_subject,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, ?)`,
      ).run(
        id,
        actor.organizationId,
        item.id,
        item.product_key,
        item.unit,
        item.location_id,
        qty,
        `on_hand ${item.on_hand} ≤ reorder ${item.reorder_point}`,
        actor.subject,
        now,
        now,
      );
      const row = db.prepare(`SELECT * FROM purchase_needs WHERE id = ?`).get(id) as PurchaseNeedRow;
      created.push(row);
      writeAudit(db, {
        aggregateType: "purchase_need",
        aggregateId: id,
        organizationId: actor.organizationId,
        eventType: "need.detected",
        actorType: actor.actorType,
        actorSubject: actor.subject,
        requestId,
        payload: {
          product_key: item.product_key,
          suggested_quantity: qty,
          on_hand: item.on_hand,
          reorder_point: item.reorder_point,
        },
      });
    }

    writeAudit(db, {
      aggregateType: "inventory",
      organizationId: actor.organizationId,
      eventType: "inventory.scanned",
      actorType: actor.actorType,
      actorSubject: actor.subject,
      requestId,
      payload: { needs_touched: created.length },
    });

    return created;
  });
}

export function listPurchaseNeeds(
  db: Db,
  buyerOrgId: string,
  status?: PurchaseNeedRow["status"],
): PurchaseNeedRow[] {
  if (status) {
    return db
      .prepare(
        `SELECT * FROM purchase_needs
         WHERE buyer_org_id = ? AND status = ?
         ORDER BY created_at DESC`,
      )
      .all(buyerOrgId, status) as PurchaseNeedRow[];
  }
  return db
    .prepare(
      `SELECT * FROM purchase_needs
       WHERE buyer_org_id = ?
       ORDER BY
         CASE status WHEN 'open' THEN 0 WHEN 'ordered' THEN 1 ELSE 2 END,
         created_at DESC`,
    )
    .all(buyerOrgId) as PurchaseNeedRow[];
}

export function dismissPurchaseNeed(
  db: Db,
  actor: ActorContext,
  needId: string,
  requestId: string,
): PurchaseNeedRow {
  return withImmediateTransaction(db, () => {
    const need = db
      .prepare(`SELECT * FROM purchase_needs WHERE id = ?`)
      .get(needId) as PurchaseNeedRow | undefined;
    if (!need || need.buyer_org_id !== actor.organizationId) {
      throw new AppError(404, "not_found", "Purchase need not found");
    }
    if (need.status !== "open") {
      throw new AppError(409, "conflict", "Only open needs can be dismissed");
    }
    const now = nowIso();
    db.prepare(
      `UPDATE purchase_needs SET status = 'dismissed', updated_at = ? WHERE id = ?`,
    ).run(now, needId);
    writeAudit(db, {
      aggregateType: "purchase_need",
      aggregateId: needId,
      organizationId: actor.organizationId,
      eventType: "need.dismissed",
      actorType: actor.actorType,
      actorSubject: actor.subject,
      requestId,
      payload: {},
    });
    return db.prepare(`SELECT * FROM purchase_needs WHERE id = ?`).get(needId) as PurchaseNeedRow;
  });
}

/** Agent places Mandate orders for each open purchase-list line. */
export async function placeOrdersForOpenNeeds(
  db: Db,
  actor: ActorContext,
  requestId: string,
  stripe: StripeAdapter,
): Promise<Array<{ need: PurchaseNeedRow; order: OrderRow }>> {
  const open = listPurchaseNeeds(db, actor.organizationId, "open");
  const results: Array<{ need: PurchaseNeedRow; order: OrderRow }> = [];

  for (const need of open) {
    const { order } = await createOrder(
      db,
      actor,
      {
        product_key: need.product_key,
        unit: need.unit,
        quantity: need.suggested_quantity,
        delivery_location_id: need.location_id,
      },
      idempotencyKeyForNeed(need.id),
      `${requestId}:${need.id}`,
      stripe,
    );

    const now = nowIso();
    db.prepare(
      `UPDATE purchase_needs SET status = 'ordered', order_id = ?, updated_at = ? WHERE id = ?`,
    ).run(order.id, now, need.id);
    writeAudit(db, {
      aggregateType: "purchase_need",
      aggregateId: need.id,
      organizationId: actor.organizationId,
      eventType: "need.ordered",
      actorType: actor.actorType,
      actorSubject: actor.subject,
      requestId,
      payload: { order_id: order.id, status: order.status },
    });
    const refreshed = db
      .prepare(`SELECT * FROM purchase_needs WHERE id = ?`)
      .get(need.id) as PurchaseNeedRow;
    results.push({ need: refreshed, order });
  }

  return results;
}

export function ensureDeliveryForPaidOrder(db: Db, order: OrderRow, requestId: string): DeliveryRow {
  const existing = db
    .prepare(`SELECT * FROM deliveries WHERE order_id = ?`)
    .get(order.id) as DeliveryRow | undefined;
  if (existing) return existing;
  if (order.status !== "paid") {
    throw new AppError(409, "conflict", "Delivery only starts after payment");
  }

  const now = nowIso();
  const eta = new Date(Date.now() + 2 * 24 * 3600_000).toISOString();
  const id = newId("dlv");
  db.prepare(
    `INSERT INTO deliveries (
       id, order_id, buyer_org_id, supplier_org_id, product_key, quantity, unit,
       location_id, status, eta_at, shipped_at, delivered_at, inventory_applied,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'packing', ?, NULL, NULL, 0, ?, ?)`,
  ).run(
    id,
    order.id,
    order.buyer_org_id,
    order.supplier_org_id,
    order.product_key,
    order.quantity,
    order.unit,
    order.delivery_location_id,
    eta,
    now,
    now,
  );
  writeAudit(db, {
    aggregateType: "delivery",
    aggregateId: id,
    organizationId: order.buyer_org_id,
    eventType: "delivery.created",
    actorType: "system",
    requestId,
    payload: { order_id: order.id, status: "packing" },
  });
  return db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(id) as DeliveryRow;
}

export function listDeliveries(db: Db, buyerOrgId: string): DeliveryRow[] {
  return db
    .prepare(
      `SELECT * FROM deliveries
       WHERE buyer_org_id = ?
       ORDER BY
         CASE status
           WHEN 'out_for_delivery' THEN 0
           WHEN 'shipped' THEN 1
           WHEN 'packing' THEN 2
           WHEN 'delivered' THEN 3
           ELSE 4
         END,
         created_at DESC`,
    )
    .all(buyerOrgId) as DeliveryRow[];
}

export function getDeliveryForOrder(db: Db, buyerOrgId: string, orderId: string): DeliveryRow | null {
  return (
    (db
      .prepare(`SELECT * FROM deliveries WHERE buyer_org_id = ? AND order_id = ?`)
      .get(buyerOrgId, orderId) as DeliveryRow | undefined) ?? null
  );
}

function applyInventoryForDelivery(db: Db, delivery: DeliveryRow, requestId: string): void {
  if (delivery.inventory_applied === 1) return;
  const item = db
    .prepare(
      `SELECT * FROM inventory_items
       WHERE buyer_org_id = ? AND product_key = ? AND location_id = ?`,
    )
    .get(delivery.buyer_org_id, delivery.product_key, delivery.location_id) as
    | InventoryItemRow
    | undefined;
  if (item) {
    const now = nowIso();
    db.prepare(
      `UPDATE inventory_items SET on_hand = on_hand + ?, updated_at = ? WHERE id = ?`,
    ).run(delivery.quantity, now, item.id);
    writeAudit(db, {
      aggregateType: "inventory",
      aggregateId: item.id,
      organizationId: delivery.buyer_org_id,
      eventType: "inventory.restocked",
      actorType: "system",
      requestId,
      payload: {
        delivery_id: delivery.id,
        product_key: delivery.product_key,
        quantity: delivery.quantity,
        previous_on_hand: item.on_hand,
      },
    });
  }
  db.prepare(`UPDATE deliveries SET inventory_applied = 1, updated_at = ? WHERE id = ?`).run(
    nowIso(),
    delivery.id,
  );
}

export function advanceDelivery(
  db: Db,
  actor: ActorContext,
  deliveryId: string,
  requestId: string,
  rawBody: unknown = {},
): DeliveryRow {
  const body = z
    .object({
      status: z
        .enum(["packing", "shipped", "out_for_delivery", "delivered", "cancelled"])
        .optional(),
    })
    .safeParse(rawBody ?? {});
  if (!body.success) {
    throw new AppError(400, "invalid_request", "Invalid delivery update");
  }

  return withImmediateTransaction(db, () => {
    const current = db
      .prepare(`SELECT * FROM deliveries WHERE id = ?`)
      .get(deliveryId) as DeliveryRow | undefined;
    if (!current || current.buyer_org_id !== actor.organizationId) {
      throw new AppError(404, "not_found", "Delivery not found");
    }

    const next = body.data.status ?? DELIVERY_NEXT[current.status];
    if (!next) {
      throw new AppError(409, "conflict", "Delivery cannot advance further");
    }
    if (body.data.status) {
      const allowed = DELIVERY_NEXT[current.status];
      if (body.data.status !== allowed && body.data.status !== "cancelled") {
        throw new AppError(409, "conflict", `Expected next status ${allowed ?? "none"}`);
      }
    }

    const now = nowIso();
    const shippedAt = next === "shipped" || next === "out_for_delivery" || next === "delivered"
      ? (current.shipped_at ?? now)
      : current.shipped_at;
    const deliveredAt = next === "delivered" ? now : current.delivered_at;

    db.prepare(
      `UPDATE deliveries SET
         status = ?, shipped_at = ?, delivered_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(next, shippedAt, deliveredAt, now, deliveryId);

    writeAudit(db, {
      aggregateType: "delivery",
      aggregateId: deliveryId,
      organizationId: actor.organizationId,
      eventType: "delivery.transition",
      actorType: actor.actorType,
      actorSubject: actor.subject,
      requestId,
      payload: { from: current.status, to: next },
    });

    let updated = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(deliveryId) as DeliveryRow;
    if (next === "delivered") {
      applyInventoryForDelivery(db, updated, requestId);
      updated = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(deliveryId) as DeliveryRow;
    }
    return updated;
  });
}

/** Demo helper: ensure baseline store inventory for the buyer org. */
export function seedDefaultInventory(db: Db, buyerOrgId: string): InventoryItemRow[] {
  const defaults = [
    {
      product_key: "avocado",
      display_name: "Hass avocados",
      category: "produce",
      unit: "case",
      location_id: "kitchen-1",
      on_hand: 1,
      reorder_point: 3,
      target_quantity: 5,
    },
    {
      product_key: "tomato",
      display_name: "Roma tomatoes",
      category: "produce",
      unit: "case",
      location_id: "kitchen-1",
      on_hand: 0,
      reorder_point: 2,
      target_quantity: 4,
    },
    {
      product_key: "lettuce",
      display_name: "Butter lettuce",
      category: "produce",
      unit: "case",
      location_id: "kitchen-1",
      on_hand: 4,
      reorder_point: 2,
      target_quantity: 4,
    },
  ];
  return defaults.map((item) => upsertInventoryItem(db, buyerOrgId, item));
}
