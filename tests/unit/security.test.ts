import { zipSync } from "fflate";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS, validateUpload } from "@/lib/imports";
import { proxy } from "@/proxy";

const sheet = { name: "s.csv", bytes: new TextEncoder().encode("SKU,Price\nA,1\n") };
const zip = (files: Record<string, Uint8Array>) => ({ name: "photos.zip", bytes: zipSync(files) });

describe("upload limits", () => {
  const saved = LIMITS.totalPhotoBytes;
  afterEach(() => {
    LIMITS.totalPhotoBytes = saved;
  });

  it("judges a ZIP by what it expands to (ZIP bomb)", () => {
    LIMITS.totalPhotoBytes = 1024 * 1024;
    const zeros = new Uint8Array(600 * 1024);
    // Compresses to almost nothing, expands past the budget.
    expect(() => validateUpload(sheet, [zip({ "a.jpg": zeros, "b.jpg": zeros })])).toThrow(/uncompressed/);
  });

  it("rejects a ZIP with no photos in it", () => {
    expect(() => validateUpload(sheet, [zip({ "readme.txt": new Uint8Array(10) })])).toThrow(/contains no photos/);
  });

  it("accepts a normal upload", () => {
    expect(() => validateUpload(sheet, [zip({ "a.jpg": new Uint8Array(100) })])).not.toThrow();
  });
});

describe("proxy access control", () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = { pw: env.ADMIN_PASSWORD, node: env.NODE_ENV };
  afterEach(() => {
    env.ADMIN_PASSWORD = saved.pw;
    env.NODE_ENV = saved.node;
  });
  const req = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    new NextRequest(`http://shop.test${path}`, { method: init.method ?? "GET", headers: { host: "shop.test", ...init.headers } });
  const basic = (pw: string) => ({ authorization: `Basic ${Buffer.from(`admin:${pw}`).toString("base64")}` });

  it("keeps the storefront and photos public", () => {
    env.ADMIN_PASSWORD = "pw";
    expect(proxy(req("/store/DE")).status).toBe(200);
    expect(proxy(req("/api/photos/123")).status).toBe(200);
  });

  it("requires the password for the dashboard and API", () => {
    env.ADMIN_PASSWORD = "pw";
    expect(proxy(req("/imports")).status).toBe(401);
    expect(proxy(req("/api/products", { headers: basic("wrong") })).status).toBe(401);
    expect(proxy(req("/api/products", { headers: basic("pw") })).status).toBe(200);
  });

  it("refuses to run without a password in production", () => {
    env.ADMIN_PASSWORD = "";
    env.NODE_ENV = "production";
    expect(proxy(req("/imports")).status).toBe(503);
  });

  it("refuses cross-site state changes even with credentials", () => {
    env.ADMIN_PASSWORD = "pw";
    const post = (headers: Record<string, string>) => proxy(req("/api/products/actions", { method: "POST", headers: { ...basic("pw"), ...headers } })).status;
    expect(post({ "sec-fetch-site": "cross-site" })).toBe(403);
    expect(post({ origin: "https://evil.test" })).toBe(403);
    expect(post({ "sec-fetch-site": "same-origin", origin: "http://shop.test" })).toBe(200);
  });
});
