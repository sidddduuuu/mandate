/**
 * Optional live Stripe *test-mode* smoke (sk_test_… only).
 * Skips unless STRIPE_SECRET_KEY starts with sk_test_.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_... npx tsx scripts/live-stripe-smoke.ts
 */
import { createStripeAdapter } from "../src/payments/stripe";
import { resetConfigCache } from "../src/lib/config";

async function main(): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!key.startsWith("sk_test_")) {
    console.log(
      JSON.stringify({
        skipped: true,
        reason:
          "Set STRIPE_SECRET_KEY to a sk_test_ key. Refuse to run against live keys.",
      }),
    );
    return;
  }

  resetConfigCache();
  const stripe = createStripeAdapter();
  const orderId = `ord_smoke_${Date.now()}`;
  const created = await stripe.createPaymentIntent({
    orderId,
    amountMinor: 3900,
    currency: "USD",
    idempotencyKey: `order:${orderId}:create`,
  });
  console.log("created", created);

  const confirmed = await stripe.confirmPaymentIntent({
    paymentIntentId: created.id,
    paymentMethod: process.env.STRIPE_DEFAULT_PAYMENT_METHOD ?? "pm_card_visa",
    idempotencyKey: `order:${orderId}:confirm`,
  });
  console.log("confirmed", confirmed);

  const retrieved = await stripe.retrievePaymentIntent(created.id);
  console.log("retrieved", retrieved);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
