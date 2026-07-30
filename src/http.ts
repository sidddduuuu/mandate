import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server.js";
import type { ZodType } from "zod";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function readJson<T>(
  request: Request,
  schema: ZodType<T>,
  maxBytes = 64 * 1024,
): Promise<T> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  }

  const body = await request.text();
  if (Buffer.byteLength(body) > maxBytes) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  }

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON");
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(400, "INVALID_REQUEST", "Request body is invalid");
  }
  return result.data;
}

export function ok(data: unknown, status = 200): NextResponse {
  return NextResponse.json({ data }, { status });
}

export async function route(
  handler: (requestId: string) => Promise<NextResponse>,
): Promise<NextResponse> {
  const requestId = randomUUID();
  try {
    const response = await handler(requestId);
    response.headers.set("x-request-id", requestId);
    return response;
  } catch (error) {
    const known = error instanceof ApiError;
    const response = NextResponse.json(
      {
        error: {
          code: known ? error.code : "INTERNAL_ERROR",
          message: known ? error.message : "The request could not be completed",
          request_id: requestId,
        },
      },
      { status: known ? error.status : 500 },
    );
    response.headers.set("x-request-id", requestId);
    return response;
  }
}

const windows = new Map<string, { count: number; resetsAt: number }>();

export function rateLimit(
  subject: string,
  limit = 60,
  windowMs = 60_000,
  now = Date.now(),
): void {
  const current = windows.get(subject);
  if (!current || current.resetsAt <= now) {
    windows.set(subject, { count: 1, resetsAt: now + windowMs });
    return;
  }
  if (current.count >= limit) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests");
  }
  current.count += 1;
}

export function requireSameOrigin(request: Request): void {
  const appBaseUrl = process.env.APP_BASE_URL;
  const origin = request.headers.get("origin");
  if (!appBaseUrl || !origin || origin !== new URL(appBaseUrl).origin) {
    throw new ApiError(403, "INVALID_ORIGIN", "Request origin is not allowed");
  }
}
