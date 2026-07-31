import { NextResponse } from "next/server";

export function requestId() {
  return crypto.randomUUID();
}

export function ok(data: unknown, id: string, status = 200) {
  return NextResponse.json({ data, request_id: id }, { status });
}

export function fail(status: number, code: string, message: string, id: string) {
  return NextResponse.json(
    { error: { code, message, request_id: id } },
    { status },
  );
}
