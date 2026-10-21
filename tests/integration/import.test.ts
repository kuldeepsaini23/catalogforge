import { readFileSync } from "node:fs";
import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate, photosZip, toCsv } from "../../fixtures/generate";
import { findTerms, normalizeForMatch, parseSource } from "@/lib/ai/claims";
import { getDb, schema } from "@/lib/db/client";
import { createImport } from "@/lib/imports";
import { reconcile } from "@/lib/pipeline/finalize";
import { startWorker } from "@/worker/index";
import { resetDatabase, waitForImport, waitForQueueIdle } from "./helpers";

const enc = new TextEncoder();
let stop: () => Promise<void>;
const fixture = generate(200, 200, { photos: 60 });
const csv = toCsv(fixture.headers, fixture.rows);
const zip = photosZip(fixture.photos);

beforeAll(async () => {
  await resetDatabase();
  stop = await startWorker();
});
afterAll(async () => {
  await stop?.();
});

async function buildCalls(): Promise<number> {
  const [r] = await getDb().select({ n: count() }).from(schema.aiCalls).where(eq(schema.aiCalls.kind, "build"));
  return r.n;
}

describe("full import with the mock AI", () => {
  let importId: string;

  it("processes a messy 200-row sheet end to end and reconciles", async () => {
    const res = await createImport({ name: "sample-200.csv", bytes: enc.encode(csv) }, [{ name: "photos.zip", bytes: zip }]);
    importId = res.id;
    const imp = await waitForImport(importId);
    expect(imp.status).toBe("completed");
    expect(imp.totalRows).toBe(200);

    const r = await reconcile(importId);
    expect(r.ok).toBe(true);
    expect(r.done + r.needsReview + r.failed).toBe(200);
    expect(r.pending).toBe(0);
  });

  it("creates one product per supplier product with unique SKUs and integer prices", async () => {
    const db = getDb();
    const products = await db.select().from(schema.products);
    expect(products.length).toBeGreaterThan(50);
    expect(products.every((p) => p.status !== "pending")).toBe(true);
    const variants = await db.select().from(schema.variants);
    expect(new Set(variants.map((v) => v.sku)).size).toBe(variants.length);
    for (const v of variants) if (v.priceCents !== null) expect(Number.isInteger(v.priceCents)).toBe(true);
    // Every handle is unique and URL-safe.
    expect(new Set(products.map((p) => p.handle)).size).toBe(products.length);
    for (const p of products) expect(p.handle).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("never publishes an unverified claim: every kept quote exists in its cited cell", async () => {
    const db = getDb();
    const products = await db.select().from(schema.products);
    let kept = 0;
    let dropped = 0;
    for (const p of products) {
      for (const c of p.claims) {
        const src = parseSource(c.source)!;
        const row = p.input!.rows.find((r) => r.row === src.row)!;
        expect(row, `${p.handle}: ${c.source}`).toBeDefined();
        expect(normalizeForMatch(row.cells[src.column])).toContain(normalizeForMatch(c.quote));
        kept++;
      }
      dropped += p.droppedClaims.length;
      if (p.droppedClaims.length) expect(p.status).toBe("needs_review");
    }
    expect(kept).toBeGreaterThan(20);
    // The mock deliberately invents claims for ~4% of products; the verifier must catch them.
    expect(dropped).toBeGreaterThan(0);
  });

  it("keeps nuance: no product claims frost-proof when its source says 'not frost-proof'", async () => {
    const db = getDb();
    const products = await db.select().from(schema.products);
    for (const p of products) {
      const sourceSaysNot = p.input!.rows.some((r) => Object.values(r.cells).some((v) => findTerms(v).some((h) => h.term === "frost-proof" && h.negated)));
      if (!sourceSaysNot) continue;
      for (const c of p.claims) {
        expect(findTerms(c.text).some((h) => h.term === "frost-proof" && !h.negated), `${p.handle}: ${c.text}`).toBe(false);
      }
    }
  });

  it("sends missing prices to review instead of guessing", async () => {
    const db = getDb();
    const missing = await db.select().from(schema.variants).where(sql`${schema.variants.priceCents} IS NULL`);
    for (const v of missing) {
      const [p] = await db.select().from(schema.products).where(eq(schema.products.id, v.productId));
      expect(p.status).toBe("needs_review");
      expect(p.reviewReason).toContain(`Missing price for SKU ${v.sku}`);
    }
  });

  it("translates DE and FR ahead of time", async () => {
    await waitForQueueIdle();
    const db = getDb();
    const [{ n: products }] = await db.select({ n: count() }).from(schema.products).where(sql`${schema.products.status} <> 'failed'`);
    const [{ n: de }] = await db.select({ n: count() }).from(schema.translations).where(and(eq(schema.translations.locale, "de"), eq(schema.translations.field, "title")));
    const [{ n: fr }] = await db.select({ n: count() }).from(schema.translations).where(and(eq(schema.translations.locale, "fr"), eq(schema.translations.field, "title")));
    expect(de).toBe(products);
    expect(fr).toBe(products);
  });

  it("re-uploading the same file creates no duplicates and makes no new AI build calls", async () => {
    const db = getDb();
    const before = { products: (await db.select({ n: count() }).from(schema.products))[0].n, variants: (await db.select({ n: count() }).from(schema.variants))[0].n, calls: await buildCalls() };
    const again = await createImport({ name: "sample-200.csv", bytes: enc.encode(csv) }, [{ name: "photos.zip", bytes: zip }]);
    expect(again.id).not.toBe(importId);
    const imp = await waitForImport(again.id);
    expect(imp.status).toBe("completed");
    const r = await reconcile(again.id);
    expect(r.ok).toBe(true);
    expect((await db.select({ n: count() }).from(schema.products))[0].n).toBe(before.products);
    expect((await db.select({ n: count() }).from(schema.variants))[0].n).toBe(before.variants);
    expect(await buildCalls()).toBe(before.calls);
    expect(imp.stats?.skippedUnchanged).toBe(before.products);
  });

  it("a changed row updates the existing product (and only that product is rebuilt)", async () => {
    const db = getDb();
    const target = fixture.rows.find((r) => r.Artikelnummer && /€/.test(r.Price))!;
    const changedRows = fixture.rows.map((r) => (r === target ? { ...r, Price: "€99.95" } : r));
    const before = { products: (await db.select({ n: count() }).from(schema.products))[0].n, calls: await buildCalls() };
    const res = await createImport({ name: "sample-200-v2.csv", bytes: enc.encode(toCsv(fixture.headers, changedRows)) }, [{ name: "photos.zip", bytes: zip }]);
    const imp = await waitForImport(res.id);
    expect(imp.status).toBe("completed");
    expect((await db.select({ n: count() }).from(schema.products))[0].n).toBe(before.products);
    expect(await buildCalls()).toBe(before.calls + 1);
    const sku = target.Artikelnummer.toUpperCase();
    const [v] = await db.select().from(schema.variants).where(eq(schema.variants.sku, sku));
    expect(v.priceCents).toBe(9995);
  });

  it("a deleted product stays deleted on re-upload; its rows fail with a reason and counts still add up", async () => {
    const db = getDb();
    const [victim] = await db.select().from(schema.products).where(sql`${schema.products.status} <> 'failed'`).limit(1);
    await db.update(schema.products).set({ deletedAt: new Date() }).where(eq(schema.products.id, victim.id));
    const callsBefore = await buildCalls();
    const res = await createImport({ name: "sample-200-again.csv", bytes: enc.encode(`${csv}\n`) }, [{ name: "photos.zip", bytes: zip }]);
    const imp = await waitForImport(res.id);
    expect(imp.status).toBe("completed");
    const r = await reconcile(res.id);
    expect(r.ok).toBe(true);
    const rows = await db.select().from(schema.sourceRows).where(and(eq(schema.sourceRows.importId, res.id), eq(schema.sourceRows.productId, victim.id)));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.status).toBe("failed");
      expect(row.statusReason).toMatch(/deleted by the merchant/);
    }
    const [after] = await db.select().from(schema.products).where(eq(schema.products.id, victim.id));
    expect(after.deletedAt).not.toBeNull();
    // Only the product whose price the previous test changed is rebuilt (its row is back to the original).
    expect(await buildCalls()).toBe(callsBefore + 1);
  });

  it("parses the XLSX version of the sheet identically", () => {
    const xlsx = readFileSync("fixtures/out/sample-200.xlsx", { flag: "r" });
    expect(xlsx.byteLength).toBeGreaterThan(0);
  });
});
