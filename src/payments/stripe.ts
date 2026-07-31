import Stripe from "stripe";
import { getConfig } from "../lib/config";
import { AppError } from "../lib/http";

export type PaymentIntentState = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
};

export type StripeAdapter = {
  createPaymentIntent(input: {
    orderId: string;
    amountMinor: number;
    currency: string;
    customerId?: string | null;
    idempotencyKey: string;
  }): Promise<PaymentIntentState>;
  confirmPaymentIntent(input: {
    paymentIntentId: string;
    paymentMethod: string;
    idempotencyKey: string;
  }): Promise<PaymentIntentState>;
  retrievePaymentIntent(paymentIntentId: string): Promise<PaymentIntentState>;
  cancelPaymentIntent(paymentIntentId: string, idempotencyKey: string): Promise<PaymentIntentState>;
  constructEvent(rawBody: string | Buffer, signature: string): Stripe.Event;
};

function mapIntent(pi: Stripe.PaymentIntent): PaymentIntentState {
  return {
    id: pi.id,
    status: pi.status,
    amount: pi.amount,
    currency: pi.currency,
    metadata: Object.fromEntries(
      Object.entries(pi.metadata ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"),
    ),
  };
}

export function createStripeAdapter(): StripeAdapter {
  const cfg = getConfig();
  if (!cfg.STRIPE_SECRET_KEY) {
    throw new AppError(500, "stripe_misconfigured", "STRIPE_SECRET_KEY is not configured");
  }
  const stripe = new Stripe(cfg.STRIPE_SECRET_KEY);

  return {
    async createPaymentIntent(input) {
      const pi = await stripe.paymentIntents.create(
        {
          amount: input.amountMinor,
          currency: input.currency.toLowerCase(),
          customer: input.customerId ?? undefined,
          confirm: false,
          metadata: { order_id: input.orderId },
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return mapIntent(pi);
    },
    async confirmPaymentIntent(input) {
      const pi = await stripe.paymentIntents.confirm(
        input.paymentIntentId,
        { payment_method: input.paymentMethod },
        { idempotencyKey: input.idempotencyKey },
      );
      return mapIntent(pi);
    },
    async retrievePaymentIntent(paymentIntentId) {
      return mapIntent(await stripe.paymentIntents.retrieve(paymentIntentId));
    },
    async cancelPaymentIntent(paymentIntentId, idempotencyKey) {
      const pi = await stripe.paymentIntents.cancel(
        paymentIntentId,
        {},
        { idempotencyKey },
      );
      return mapIntent(pi);
    },
    constructEvent(rawBody, signature) {
      const secret = cfg.STRIPE_WEBHOOK_SECRET;
      if (!secret) {
        throw new AppError(500, "stripe_misconfigured", "STRIPE_WEBHOOK_SECRET is not configured");
      }
      return stripe.webhooks.constructEvent(rawBody, signature, secret);
    },
  };
}

/** In-memory Stripe stub for tests. */
export function createMemoryStripeAdapter(): StripeAdapter & {
  intents: Map<string, PaymentIntentState & { canceled?: boolean }>;
  events: Stripe.Event[];
  failNextCreate?: boolean;
} {
  const intents = new Map<string, PaymentIntentState & { canceled?: boolean }>();
  const createKeys = new Map<string, string>();
  let seq = 0;
  const api: StripeAdapter & {
    intents: Map<string, PaymentIntentState & { canceled?: boolean }>;
    events: Stripe.Event[];
    failNextCreate?: boolean;
  } = {
    intents,
    events: [],
    async createPaymentIntent(input) {
      if (api.failNextCreate) {
        api.failNextCreate = false;
        throw new Error("stripe_create_failed");
      }
      const existingId = createKeys.get(input.idempotencyKey);
      if (existingId) return intents.get(existingId)!;
      const id = `pi_test_${++seq}`;
      const state: PaymentIntentState = {
        id,
        status: "requires_confirmation",
        amount: input.amountMinor,
        currency: input.currency.toLowerCase(),
        metadata: { order_id: input.orderId },
      };
      intents.set(id, state);
      createKeys.set(input.idempotencyKey, id);
      return state;
    },
    async confirmPaymentIntent(input) {
      const pi = intents.get(input.paymentIntentId);
      if (!pi) throw new Error("not_found");
      if (pi.canceled) {
        pi.status = "canceled";
        return pi;
      }
      pi.status = "succeeded";
      return pi;
    },
    async retrievePaymentIntent(paymentIntentId) {
      const pi = intents.get(paymentIntentId);
      if (!pi) throw new Error("not_found");
      return pi;
    },
    async cancelPaymentIntent(paymentIntentId) {
      const pi = intents.get(paymentIntentId);
      if (!pi) throw new Error("not_found");
      pi.status = "canceled";
      pi.canceled = true;
      return pi;
    },
    constructEvent(rawBody, signature) {
      if (signature !== "test_sig") {
        throw new Error("invalid signature");
      }
      return JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")) as Stripe.Event;
    },
  };
  return api;
}
