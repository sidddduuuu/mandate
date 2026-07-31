"use client";

import { useEffect, useState } from "react";

export function FundWallet({
  balanceMinor,
}: Readonly<{ balanceMinor: number }>) {
  const [dollars, setDollars] = useState(10);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const funding = new URLSearchParams(window.location.search).get("funding");
    if (funding === "cancelled") {
      setStatus("Stripe Checkout cancelled. No funds were added.");
      return;
    }
    if (funding !== "success") return;
    setBusy(true);
    setStatus("Stripe payment complete. Waiting for signed webhook…");
    const before = Number(
      window.sessionStorage.getItem("walletBalanceBeforeCheckout") ?? -1,
    );
    let attempts = 0;
    const checkWallet = async () => {
      try {
        attempts += 1;
        const response = await fetch("/api/wallet", { cache: "no-store" });
        const result = await response.json() as {
          data?: { balanceMinor?: number };
        };
        if (
          (result.data?.balanceMinor ?? balanceMinor) <= before
          && attempts < 20
        ) return;
        window.sessionStorage.removeItem("walletBalanceBeforeCheckout");
        window.clearInterval(timer);
        window.location.replace("/dashboard/wallet");
      } catch {
        window.clearInterval(timer);
        setBusy(false);
        setStatus("Could not confirm wallet funding. Refresh to try again.");
      }
    };
    const timer = window.setInterval(() => void checkWallet(), 750);
    return () => window.clearInterval(timer);
  }, [balanceMinor]);

  const fund = async () => {
    if (!Number.isFinite(dollars) || dollars < 10 || dollars > 1000) {
      setStatus("Enter an amount from $10 to $1,000.");
      return;
    }
    setBusy(true);
    setStatus("Opening Stripe Checkout…");
    try {
      const response = await fetch("/api/wallet/topups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountMinor: Math.round(dollars * 100) }),
      });
      const payload = await response.json() as {
        data?: { checkoutUrl?: string };
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(payload.error?.message || "Wallet funding failed");
      }
      if (!payload.data?.checkoutUrl) throw new Error("Stripe Checkout unavailable");
      window.sessionStorage.setItem(
        "walletBalanceBeforeCheckout",
        String(balanceMinor),
      );
      window.location.assign(payload.data.checkoutUrl);
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : "Wallet funding failed");
      setBusy(false);
    }
  };

  return (
    <div className="wallet-fund">
      <label htmlFor="wallet-fund-amount">Fund wallet with Stripe</label>
      <div>
        <span aria-hidden="true">$</span>
        <input
          id="wallet-fund-amount"
          type="number"
          min="10"
          max="1000"
          step="10"
          value={dollars}
          disabled={busy}
          aria-describedby="wallet-fund-status"
          aria-invalid={dollars < 10 || dollars > 1000}
          onChange={(event) => setDollars(Number(event.target.value))}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void fund()}
        >
          {busy ? "Funding…" : "Add funds →"}
        </button>
      </div>
      <p id="wallet-fund-status" role="status">
        {status || "Minimum $10 · opens Stripe Checkout in test mode"}
      </p>
    </div>
  );
}
