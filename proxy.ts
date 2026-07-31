import { getAuth0Client } from "./src/auth/client.ts";

export async function proxy(request: Request) {
  return getAuth0Client().middleware(request);
}

export const config = {
  matcher: [
    "/auth/:path*",
    "/dashboard/:path*",
    "/supplier/:path*",
    "/api/approvals/:path*",
    "/api/mandates/:path*",
    "/api/orders/:id/approval",
    "/api/suppliers/:path*",
  ],
};
