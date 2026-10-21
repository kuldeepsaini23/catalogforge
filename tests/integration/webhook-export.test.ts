import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate, toCsv } from "../../fixtures/generate";
import { decimalPrice, exportShopifyCsv } from "@/lib/export";
import { createImport } from "@/lib/imports";
import { resetDatabase, waitFor, waitForImport } from "./helpers";

const received: Array<{ body: string; signature: string | undefined; timestamp: string | undefined }> = [];
let server: Server;
let stop: () => Promise<void>;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ body, signature: req.headers["x-catalogforge-signature"] as string | undefined, timestamp: req.headers["x-catalogforge-timestamp"] as string | undefined });
      // First delivery fails: proves the queue retries it.
      res.statusCode = received.length === 1 ? 500 : 204;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.IMPORT_WEBHOOK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  process.env.IMPORT_WEBHOOK_SECRET = "s3cret";
  await resetDatabase();
  const { startWorker } = await import("@/worker/index");
  stop = await startWorker();
});
afterAll(async () => {
  await stop?.();
  server?.close();
});

describe("import webhook and Shopify export", () => {
  it("posts a signed summary when the import completes, retrying a failed delivery", async () => {
    const g = generate(60, 5, { photos: 0 });
    const { id } = await createImport({ name: "hook.csv", bytes: new TextEncoder().encode(toCsv(g.headers, g.rows)) }, []);
    await waitForImport(id);
    await waitFor(async () => received.length >= 2, { timeoutMs: 60_000, label: "webhook retry" });
    const last = received[received.length - 1];
    const payload = JSON.parse(last.body);
    expect(payload).toMatchObject({ event: "import.completed", import: { id, totalRows: 60 }, rows: { total: 60 } });
    expect(payload.rows.done + payload.rows.needsReview + payload.rows.failed).toBe(60);
    expect(Math.abs(Number(last.timestamp) - Date.now() / 1000)).toBeLessThan(300);
    expect(last.signature).toBe(`sha256=${createHmac("sha256", "s3cret").update(`${last.timestamp}.${last.body}`).digest("hex")}`);
  });

  it("exports Shopify's product CSV: one row per variant, product fields on the first row", async () => {
    let csv = "";
    for await (const chunk of exportShopifyCsv("all", "http://shop.test")) csv += chunk;
    const lines = csv.trim().split("\n");
    expect(lines[0]).toMatch(/^Handle,Title,Body \(HTML\),Vendor,/);
    expect(lines.length).toBeGreaterThan(10);
    expect(decimalPrice(129900)).toBe("1299.00");
    expect(decimalPrice(5)).toBe("0.05");
    expect(decimalPrice(null)).toBe("");
  });
});
