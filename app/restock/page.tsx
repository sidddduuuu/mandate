import { redirect } from "next/navigation";

import { getAuth0Client } from "../../src/auth/client";

export const dynamic = "force-dynamic";

export default async function RestockEntry() {
  if (await getAuth0Client().getSession()) redirect("/dashboard/restock");
  redirect("/auth/login?returnTo=%2Fdashboard%2Frestock");
}
