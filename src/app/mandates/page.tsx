export default function MandatesPage() {
  return (
    <main>
      <p className="eyebrow">Purchasing Mandate</p>
      <h1>Create active authority</h1>
      <p id="form-status" role="status">
        Submit UTC timestamps and integer minor-unit limits. Future activation is not supported.
      </p>
      <form action="/api/mandates" method="post" aria-describedby="form-status">
        <label>Valid from (UTC)<input name="valid_from" placeholder="2026-07-30T20:00:00.000Z" required /></label>
        <label>Valid until (UTC)<input name="valid_until" placeholder="2026-08-30T20:00:00.000Z" required /></label>
        <label>Currency<input name="currency" pattern="[A-Z]{3}" defaultValue="USD" required /></label>
        <label>Autonomous limit<input name="autonomous_limit_minor" type="number" min="0" required /></label>
        <label>Hard limit<input name="hard_limit_minor" type="number" min="1" required /></label>
        <label>Budget window start (UTC)<input name="budget_starts_at" placeholder="2026-07-01T00:00:00.000Z" required /></label>
        <label>Budget window end (UTC)<input name="budget_ends_at" placeholder="2026-08-01T00:00:00.000Z" required /></label>
        <label>Budget limit<input name="budget_limit_minor" type="number" min="1" required /></label>
        <label>Allowed supplier IDs (comma-separated)<input name="allowed_supplier_ids" required /></label>
        <label>Allowed categories (comma-separated)<input name="allowed_categories" required /></label>
        <label>Delivery location IDs (comma-separated)<input name="delivery_location_ids" required /></label>
        <button type="submit">Create Purchasing Mandate</button>
      </form>
    </main>
  );
}
