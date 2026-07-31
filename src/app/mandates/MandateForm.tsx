"use client";

import { useEffect, useState, type FormEvent } from "react";
import { apiGet, apiMutate } from "@/lib/client-api";
import { formatMoney } from "@/lib/format";

type MandateResult = {
  id: string;
  version: number;
  status: string;
  policy_hash: string;
  policy: {
    currency: string;
    autonomous_order_limit_minor: number;
    hard_exception_limit_minor: number;
    budget_limit_minor: number;
  };
};

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 3600_000).toISOString();
}

export function MandateForm() {
  const [currency, setCurrency] = useState("USD");
  const [autonomous, setAutonomous] = useState("50");
  const [hard, setHard] = useState("500");
  const [budget, setBudget] = useState("1000");
  const [suppliers, setSuppliers] = useState("");
  const [categories, setCategories] = useState("produce");
  const [locations, setLocations] = useState("kitchen-1");
  const [days, setDays] = useState("30");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MandateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [supplierOptions, setSupplierOptions] = useState<
    Array<{ id: string; name: string; auth0_org_id: string }>
  >([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<{
          organizations: Array<{
            id: string;
            name: string;
            auth0_org_id: string;
            kind: string;
          }>;
        }>("/api/orgs");
        if (cancelled) return;
        const suppliersOnly = data.organizations.filter((o) => o.kind === "supplier");
        setSupplierOptions(suppliersOnly);
        setSuppliers((prev) =>
          prev.trim() ? prev : suppliersOnly.map((s) => s.id).join(", "),
        );
      } catch {
        // Form still usable with manual ids
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const autonomousMinor = Math.round(Number(autonomous) * 100);
      const hardMinor = Math.round(Number(hard) * 100);
      const budgetMinor = Math.round(Number(budget) * 100);
      const from = new Date(Date.now() - 60_000).toISOString();
      const until = isoDaysFromNow(Number(days) || 30);
      const body = {
        currency: currency.trim().toUpperCase(),
        autonomous_order_limit_minor: autonomousMinor,
        hard_exception_limit_minor: hardMinor,
        budget_window_start: from,
        budget_window_end: until,
        budget_limit_minor: budgetMinor,
        allowed_supplier_org_ids: suppliers
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        allowed_categories: categories
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        allowed_delivery_location_ids: locations
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        valid_from: from,
        valid_until: until,
      };
      const data = await apiMutate<MandateResult>("/api/mandates", {
        method: "POST",
        body,
      });
      setResult(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error ? (
        <div className="alert" role="alert">
          {error}
        </div>
      ) : null}
      {result ? (
        <div className="alert alert-ok" role="status">
          Mandate v{result.version} is {result.status}. Autonomous{" "}
          {formatMoney(result.policy.autonomous_order_limit_minor, result.policy.currency)}, hard{" "}
          {formatMoney(result.policy.hard_exception_limit_minor, result.policy.currency)}. Hash{" "}
          <span className="mono">{result.policy_hash.slice(0, 12)}…</span>
        </div>
      ) : null}

      <form className="form-stack" onSubmit={(e) => void onSubmit(e)}>
        <div className="field">
          <label htmlFor="currency">Currency</label>
          <input id="currency" value={currency} onChange={(e) => setCurrency(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="autonomous">Autonomous order limit (major units)</label>
          <input
            id="autonomous"
            inputMode="decimal"
            value={autonomous}
            onChange={(e) => setAutonomous(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="hard">Hard exception limit (major units)</label>
          <input id="hard" inputMode="decimal" value={hard} onChange={(e) => setHard(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="budget">Period budget limit (major units)</label>
          <input
            id="budget"
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="days">Valid for (days)</label>
          <input id="days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="suppliers">
            Allowed supplier organization IDs (comma-separated internal ids from{" "}
            <span className="mono">npm run seed</span>)
          </label>
          <textarea
            id="suppliers"
            value={suppliers}
            onChange={(e) => setSuppliers(e.target.value)}
            placeholder="org_…, org_…"
            required
          />
          {supplierOptions.length > 0 ? (
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Seeded:{" "}
              {supplierOptions.map((s) => `${s.name} (${s.id})`).join(" · ")}
            </p>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="categories">Allowed categories</label>
          <input
            id="categories"
            value={categories}
            onChange={(e) => setCategories(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="locations">Allowed delivery locations</label>
          <input
            id="locations"
            value={locations}
            onChange={(e) => setLocations(e.target.value)}
            required
          />
        </div>
        <div className="actions">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            Publish mandate version
          </button>
        </div>
      </form>
    </div>
  );
}
