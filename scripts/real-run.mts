/**
 * Real-model run: imports a labelled sheet with the real Claude models (Anthropic API or Vercel
 * AI Gateway), then reports throughput, cost and what the claim verifier did, and scores grouping
 * against the generator's ground truth. Uses its own database so mock numbers stay separate.
 *
 *   REAL_DATABASE_URL=postgres://…/catalogforge_real bun run real-run -- [rows=200] [photos=60]
 *
 * Output: stdout + load/results/real-run.json. Spends real money (≈ $0.5 per 200 rows).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { generate, photosZip, toCsv } from "../fixtures/generate";
import { cleanSheet } from "../src/lib/cleaning";

const rowsN = Number(process.argv[2] ?? 200);
const photosN = Number(process.argv[3] ?? 60);
if (!process.env.REAL_DATABASE_URL) throw new Error("Set REAL_DATABASE_URL to a database that may be wiped");
process.env.DATABASE_URL = process.env.REAL_DATABASE_URL;
process.env.AI_PROVIDER = "anthropic";

const { getDb } = await import("../src/lib/db/client");
const { runMigrations } = await import("../src/lib/db/migrate");
const { createImport } = await import("../src/lib/imports");
const { reconcile } = await import("../src/lib/pipeline/finalize");
const { getMetrics } = await import("../src/lib/metrics");
const { formatUsd } = await import("../src/lib/ai/pricing");
const { env } = await import("../src/lib/env");

await runMigrations();
const db = getDb();
await db.execute(sql`TRUNCATE imports, source_rows, products, variants, photos, translations, translation_cache, ai_calls, ai_batches, storefront_products RESTART IDENTITY CASCADE`);
await db.execute(sql`DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'pgboss' AND table_name = 'job') THEN EXECUTE 'DELETE FROM pgboss.job'; END IF; END $$`);

const { startWorker } = await import("../src/worker/index");
const stop = await startWorker();

const g = generate(rowsN, rowsN, { photos: photosN });
const started = Date.now();
const { id } = await createImport(
  { name: `real-${rowsN}.csv`, bytes: new TextEncoder().encode(toCsv(g.headers, g.rows)) },
  photosN ? [{ name: "photos.zip", bytes: photosZip(g.photos) }] : [],
);
console.log(`import ${id}: ${rowsN} rows, ${photosN} photos, gateway=${Boolean(env().AI_GATEWAY_API_KEY)}, batch=${env().AI_USE_BATCH}`);

for (;;) {
  const imp = await db.query.imports.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  const r = await reconcile(id);
  process.stdout.write(`\r${imp?.status} ${r.total - r.pending}/${rowsN} rows, ${Math.round((Date.now() - started) / 1000)}s   `);
  if (imp && (imp.status === "completed" || imp.status === "failed")) break;
  await new Promise((res) => setTimeout(res, 2000));
}
const importSeconds = (Date.now() - started) / 1000;
// Translations run after the build; wait for the queue to drain so their cost is included.
for (;;) {
  const q = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM pgboss.job WHERE state IN ('created','retry','active') AND name <> 'import-sweep'`);
  if (Number(q.rows[0].n) === 0) break;
  await new Promise((res) => setTimeout(res, 2000));
}
const totalSeconds = (Date.now() - started) / 1000;
process.stdout.write("\n");

const r = await reconcile(id);
const m = await getMetrics();

// Grouping vs ground truth: rows of one true family must land in one product, and a product must
// not mix families.
const rowsRes = await db.execute<{ row_number: number; product_id: string | null }>(sql`SELECT row_number, product_id FROM source_rows WHERE import_id = ${id}`);
const truthByRow = new Map(cleanSheet(g.headers, g.rows).rows.map((cr, i) => [cr.row, g.truth[i]]));
const familyProducts = new Map<string, Set<string>>();
const productFamilies = new Map<string, Set<string>>();
for (const row of rowsRes.rows) {
  const t = truthByRow.get(row.row_number);
  if (!t || !row.product_id) continue;
  if (!familyProducts.has(t.family)) familyProducts.set(t.family, new Set());
  familyProducts.get(t.family)!.add(row.product_id);
  if (!productFamilies.has(row.product_id)) productFamilies.set(row.product_id, new Set());
  productFamilies.get(row.product_id)!.add(t.family);
}
const split = [...familyProducts.values()].filter((s) => s.size > 1).length;
const mixed = [...productFamilies.values()].filter((s) => s.size > 1).length;

const claimsRes = await db.execute<{ title: string; claims: Array<{ text: string; quote?: string }>; dropped: Array<{ text: string; reason: string }> }>(sql`
  SELECT title, claims, dropped_claims AS dropped FROM products WHERE last_import_id = ${id} AND deleted_at IS NULL`);
const kept = claimsRes.rows.reduce((n, p) => n + p.claims.length, 0);
const dropped = claimsRes.rows.flatMap((p) => p.dropped.map((d) => ({ product: p.title, ...d })));
const reviewReasons = await db.execute<{ reason: string; n: string }>(sql`
  SELECT coalesce(review_reason, '(none)') AS reason, count(*) AS n FROM products
  WHERE last_import_id = ${id} AND status = 'needs_review' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`);
const translationIssues = await db.execute<{ locale: string; status: string; n: string }>(sql`
  SELECT locale, status, count(*) AS n FROM translations GROUP BY 1, 2 ORDER BY 1, 2`);
const sample = await db.execute(sql`SELECT title, category, description_html, claims, dropped_claims, confidence, status FROM products WHERE last_import_id = ${id} AND jsonb_array_length(claims) > 0 LIMIT 2`);

const result = {
  rows: rowsN,
  photos: photosN,
  gateway: Boolean(env().AI_GATEWAY_API_KEY),
  modelIds: { cheap: env().AI_MODEL_CHEAP, strong: env().AI_MODEL_STRONG },
  importSeconds: Math.round(importSeconds),
  totalSecondsWithTranslations: Math.round(totalSeconds),
  rowsPerMinute: Math.round(rowsN / (importSeconds / 60)),
  reconciliation: r,
  products: m.products,
  grouping: { trueFamilies: familyProducts.size, products: productFamilies.size, splitFamilies: split, mixedProducts: mixed },
  cost: {
    actual: formatUsd(m.cost.actualNanos),
    baseline: formatUsd(m.cost.baselineNanos),
    perProduct: formatUsd(m.cost.perProductNanos),
    per1kProducts: formatUsd(m.cost.perProductNanos * 1000),
    savedPct: m.cost.baselineNanos ? Math.round((1 - m.cost.actualNanos / m.cost.baselineNanos) * 100) : 0,
  },
  models: m.models,
  outcomes: m.aiOutcomes,
  speed: m.speed,
  claims: { kept, dropped: dropped.length, droppedExamples: dropped.slice(0, 15) },
  reviewReasons: reviewReasons.rows,
  translations: translationIssues.rows,
  sample: sample.rows,
};
mkdirSync("load/results", { recursive: true });
writeFileSync("load/results/real-run.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, sample: undefined }, null, 2));
await stop();
process.exit(0);
