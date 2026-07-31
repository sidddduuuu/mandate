export type ApiError = {
  error: { code: string; message: string; request_id: string };
};

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin" });
  const body = (await res.json()) as { data?: T } & Partial<ApiError>;
  if (!res.ok) {
    throw new Error(body.error?.message ?? `Request failed (${res.status})`);
  }
  return body.data as T;
}

export async function apiMutate<T>(
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const res = await fetch(path, {
    method: init.method,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": "mandate",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = (await res.json()) as { data?: T } & Partial<ApiError>;
  if (!res.ok) {
    throw new Error(body.error?.message ?? `Request failed (${res.status})`);
  }
  return body.data as T;
}

export type OrderView = {
  id: string;
  status: string;
  product_key: string;
  sku: string;
  category: string;
  unit: string;
  quantity: number;
  unit_price_minor: number;
  total_minor: number;
  currency: string;
  delivery_location_id: string;
  policy_decision: string;
  policy_reasons: string[];
  approval_expires_at: string | null;
  stripe_payment_intent_id: string | null;
  created_at: string;
  updated_at: string;
  mandate_version?: number;
  supplier_org_id?: string;
};

export type DeliveryView = {
  id: string;
  order_id: string;
  product_key: string;
  quantity: number;
  unit: string;
  location_id: string;
  status: string;
  eta_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  inventory_applied: boolean;
  next_status: string | null;
};

export type AuditEventView = {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  actor_type: string;
  actor_subject: string;
  request_id: string;
  payload: unknown;
  created_at: string;
};
