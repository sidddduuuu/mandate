import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server.js";
import { type ZodType } from "zod";
import { AuthError } from "./auth/context.ts";
import type { Database } from "./db.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function parseRequest<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(400, "INVALID_REQUEST", "Request is invalid");
  }
  return result.data;
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

  return parseRequest(schema, value);
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
    const auth = error instanceof AuthError;
    const known = error instanceof ApiError;
    const status = known
      ? error.status
      : auth
        ? error.code === "forbidden"
          ? 403
          : error.code === "invalid_configuration"
            ? 503
            : 401
        : 500;
    const code = known
      ? error.code
      : auth
        ? error.code === "forbidden"
          ? "FORBIDDEN"
          : error.code === "invalid_configuration"
            ? "AUTH_UNAVAILABLE"
            : "UNAUTHORIZED"
        : "INTERNAL_ERROR";
    const message = known
      ? error.message
      : auth
        ? error.code === "invalid_configuration"
          ? "Authentication is unavailable"
          : "Unauthorized"
        : "The request could not be completed";
    const response = NextResponse.json(
      {
        error: {
          code,
          message,
          request_id: requestId,
        },
      },
      { status },
    );
    if (status === 401) response.headers.set("www-authenticate", "Bearer");
    response.headers.set("x-request-id", requestId);
    return response;
  }
}

export async function rateLimit(
  database: Database,
  subject: string,
  limit = 60,
  windowMs = 60_000,
): Promise<void> {
  if (
    !subject
    || subject.length > 512
    || !Number.isSafeInteger(limit)
    || limit < 1
    || !Number.isSafeInteger(windowMs)
    || windowMs < 1
  ) {
    throw new TypeError("Rate limit configuration is invalid");
  }
  const sqlite = "prepare" in database;
  const modifier = `+${windowMs / 1_000} seconds`;
  const row = await database.get(
    sqlite
      ? `
        INSERT INTO rate_limit_windows AS current (
          key, request_count, resets_at
        ) VALUES (
          ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
        )
        ON CONFLICT (key) DO UPDATE SET
          request_count = CASE
            WHEN current.resets_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              THEN 1
            WHEN current.request_count <= ? THEN current.request_count + 1
            ELSE current.request_count
          END,
          resets_at = CASE
            WHEN current.resets_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
            ELSE current.resets_at
          END
        RETURNING request_count
      `
      : `
        INSERT INTO rate_limit_windows AS current (
          key, request_count, resets_at
        ) VALUES (
          ?, 1, statement_timestamp() + ?::double precision * interval '1 millisecond'
        )
        ON CONFLICT (key) DO UPDATE SET
          request_count = CASE
            WHEN current.resets_at <= statement_timestamp() THEN 1
            WHEN current.request_count <= ? THEN current.request_count + 1
            ELSE current.request_count
          END,
          resets_at = CASE
            WHEN current.resets_at <= statement_timestamp()
              THEN statement_timestamp() + ?::double precision * interval '1 millisecond'
            ELSE current.resets_at
          END
        RETURNING request_count
      `,
    ...(sqlite
      ? [subject, modifier, limit, modifier]
      : [subject, windowMs, limit, windowMs]),
  );
  const count = Number(row?.request_count);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Rate limit update returned an invalid count");
  }
  if (count > limit) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests");
  }
}

export function requireSameOrigin(request: Request): void {
  const appBaseUrl = process.env.APP_BASE_URL;
  const origin = request.headers.get("origin");
  if (!appBaseUrl || !origin || origin !== new URL(appBaseUrl).origin) {
    throw new ApiError(403, "INVALID_ORIGIN", "Request origin is not allowed");
  }
}
