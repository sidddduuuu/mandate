"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireHumanPermission } from "@/auth/context";
import { getStripe } from "@/lib/api";
import { AppError } from "@/lib/http";
import { newId } from "@/lib/ids";
import { decideApproval } from "@/procurement/orders";
import { getApprovalSession } from "./session";

export async function decideApprovalAction(formData: FormData) {
  let result = "updated";
  try {
    const requestHeaders = await headers();
    const origin = requestHeaders.get("origin");
    const host =
      requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
    const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
    if (!origin || !host || new URL(origin).origin !== `${protocol}://${host}`) {
      throw new AppError(403, "csrf_failed", "CSRF validation failed");
    }

    const { db, actor } = await getApprovalSession();
    if (!actor) throw new AppError(401, "unauthorized", "Authentication required");
    requireHumanPermission(actor, "approvals:decide");

    const orderId = String(formData.get("order_id") ?? "");
    const decision = String(formData.get("decision") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();
    await decideApproval(
      db,
      actor,
      orderId,
      { decision, ...(reason ? { reason } : {}) },
      newId("req"),
      getStripe(),
    );
    result = decision === "approve" ? "approved" : "rejected";
  } catch (error) {
    result = error instanceof AppError ? error.code : "unexpected_error";
  }

  revalidatePath("/approvals");
  redirect(`/approvals?result=${encodeURIComponent(result)}`);
}
