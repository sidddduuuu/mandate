import { NextResponse } from "next/server";
import { newId } from "./ids";

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    request_id: string;
  };
};

export function getRequestId(request: Request): string {
  return request.headers.get("x-request-id")?.trim() || newId("req");
}

export function jsonOk<T>(data: T, init?: ResponseInit & { requestId?: string }): NextResponse {
  const headers = new Headers(init?.headers);
  if (init?.requestId) headers.set("x-request-id", init.requestId);
  return NextResponse.json({ data }, { ...init, headers });
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  requestId: string,
): NextResponse {
  const body: ApiErrorBody = {
    error: { code, message, request_id: requestId },
  };
  return NextResponse.json(body, {
    status,
    headers: { "x-request-id": requestId },
  });
}

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function toErrorResponse(err: unknown, requestId: string): NextResponse {
  if (err instanceof AppError) {
    return jsonError(err.status, err.code, err.message, requestId);
  }
  console.error("unhandled_error", { requestId, err });
  return jsonError(500, "internal_error", "Internal server error", requestId);
}
