import type { Metadata } from "next";

import { RestockRun } from "./restock-run";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Codex restock run — Mandate" };

export default function RestockPage() {
  return <RestockRun />;
}
