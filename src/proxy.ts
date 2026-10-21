import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Access control. The storefront, product photos and the published-handle index are public; the
 * dashboard and every other API route (uploads, approvals, AI re-runs that cost money, exports)
 * need ADMIN_PASSWORD via HTTP Basic auth (any user name). Without a password set, access is
 * open in development only. State-changing requests must also come from this site (CSRF).
 */
const PUBLIC = [/^\/store(\/|$)/, /^\/api\/photos\//, /^\/api\/storefront-index$/];

function passwordMatches(header: string | null, password: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const given = Buffer.from(decoded.slice(decoded.indexOf(":") + 1));
  const expected = Buffer.from(password);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function crossSite(request: NextRequest): boolean {
  if (request.method === "GET" || request.method === "HEAD") return false;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = request.headers.get("origin");
  return Boolean(origin && new URL(origin).host !== request.headers.get("host"));
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next();

  const password = process.env.ADMIN_PASSWORD;
  if (!password && process.env.NODE_ENV === "production") {
    return new NextResponse("Set ADMIN_PASSWORD to use the dashboard and API.", { status: 503 });
  }
  if (password && !passwordMatches(request.headers.get("authorization"), password)) {
    return new NextResponse("Authentication required.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="CatalogForge", charset="UTF-8"' },
    });
  }
  if (crossSite(request)) return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
  return NextResponse.next();
}

export const config = {
  // Everything except Next's own assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
