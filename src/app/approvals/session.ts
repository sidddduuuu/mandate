import { headers } from "next/headers";
import { actorFromAuth0Session } from "@/auth/context";
import { getDb } from "@/db";
import { getConfig } from "@/lib/config";

export async function getApprovalSession() {
  const requestHeaders = await headers();
  const request = new Request(new URL("/approvals", getConfig().APP_BASE_URL), {
    headers: new Headers(requestHeaders),
  });
  const db = getDb();
  return { db, actor: await actorFromAuth0Session(db, request) };
}
