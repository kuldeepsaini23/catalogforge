import { sql } from "drizzle-orm";
import { costNanos } from "@/lib/ai/pricing";
import { getDb } from "@/lib/db/client";
import { env } from "@/lib/env";

const num = (v: unknown) => Number(v ?? 0);

export async function getMetrics() {
  const db = getDb();
  const strong = env().AI_MODEL_STRONG;

  const [statusRes, rowRes, callGroups, timeRes, speedRes, slowRes, coverageRes, claimRes, outcomeRes, importRes] = await Promise.all([
    db.execute<{ status: string; n: string }>(sql`SELECT status, count(*) AS n FROM products GROUP BY status`),
    db.execute<{ status: string; n: string }>(sql`SELECT status, count(*) AS n FROM source_rows GROUP BY status`),
    db.execute<{ model: string; mode: string; kind: string; calls: string; products: string; vision: string; input: string; output: string; cache_read: string; cache_write: string; cost: string; baseline: string }>(sql`
      SELECT model, mode, kind, count(*) AS calls, sum(product_count) AS products, count(*) FILTER (WHERE vision) AS vision,
        sum(input_tokens) AS input, sum(output_tokens) AS output, sum(cache_read_tokens) AS cache_read,
        sum(cache_write_tokens) AS cache_write, sum(cost_nanos) AS cost, sum(baseline_nanos) AS baseline
      FROM ai_calls GROUP BY model, mode, kind ORDER BY model, mode, kind`),
    db.execute<{ bucket: string; cost: string; baseline: string; calls: string }>(sql`
      WITH span AS (SELECT max(created_at) - min(created_at) AS s FROM ai_calls)
      SELECT date_trunc(CASE WHEN (SELECT s FROM span) > interval '2 days' THEN 'day' WHEN (SELECT s FROM span) > interval '3 hours' THEN 'hour' ELSE 'minute' END, created_at) AS bucket,
        sum(cost_nanos) AS cost, sum(baseline_nanos) AS baseline, count(*) AS calls
      FROM ai_calls GROUP BY 1 ORDER BY 1`),
    db.execute<{ avg: string; p50: string; p95: string; max: string; n: string }>(sql`
      SELECT avg(processing_ms) AS avg, percentile_cont(0.5) WITHIN GROUP (ORDER BY processing_ms) AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY processing_ms) AS p95, max(processing_ms) AS max, count(processing_ms) AS n
      FROM products WHERE processing_ms IS NOT NULL`),
    db.execute<{ id: string; handle: string; title: string; processing_ms: string; model: string }>(sql`
      SELECT id, handle, title, processing_ms, model FROM products WHERE processing_ms IS NOT NULL ORDER BY processing_ms DESC LIMIT 5`),
    db.execute<{ locale: string; status: string; n: string }>(sql`
      SELECT t.locale, t.status, count(*) AS n FROM translations t JOIN products p ON p.id = t.product_id
      WHERE p.status <> 'failed' GROUP BY t.locale, t.status`),
    db.execute<{ kept: string; dropped: string; products_with_dropped: string }>(sql`
      SELECT sum(jsonb_array_length(claims)) AS kept, sum(jsonb_array_length(dropped_claims)) AS dropped,
        count(*) FILTER (WHERE jsonb_array_length(dropped_claims) > 0) AS products_with_dropped FROM products`),
    db.execute<{ outcome: string; n: string }>(sql`SELECT outcome, count(*) AS n FROM ai_calls GROUP BY outcome`),
    db.execute<{ id: string; file_name: string; total_rows: string; seconds: string; status: string; mode: string; cost: string }>(sql`
      SELECT i.id, i.file_name, i.total_rows, extract(epoch FROM (coalesce(i.finished_at, now()) - i.started_at)) AS seconds, i.status, i.mode,
        (SELECT sum(cost_nanos) FROM ai_calls c WHERE c.import_id = i.id) AS cost
      FROM imports i WHERE i.started_at IS NOT NULL ORDER BY i.created_at DESC LIMIT 10`),
  ]);

  const products: Record<string, number> = { pending: 0, done: 0, needs_review: 0, failed: 0, approved: 0 };
  for (const r of statusRes.rows) products[r.status] = num(r.n);
  const totalProducts = Object.values(products).reduce((a, b) => a + b, 0);
  const processed = totalProducts - products.pending;
  const rows: Record<string, number> = { pending: 0, done: 0, needs_review: 0, failed: 0 };
  for (const r of rowRes.rows) rows[r.status] = num(r.n);

  // Savings decomposition: baseline (strong, sync, uncached) → actual.
  let actual = 0;
  let baseline = 0;
  let savedRouting = 0;
  let savedBatching = 0;
  let savedCaching = 0;
  const models = callGroups.rows.map((g) => {
    const usage = { inputTokens: num(g.input), outputTokens: num(g.output), cacheReadTokens: num(g.cache_read), cacheWriteTokens: num(g.cache_write) };
    const uncached = { ...usage, inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const mode = g.mode as "sync" | "batch";
    const cost = num(g.cost);
    actual += cost;
    baseline += num(g.baseline);
    const strongUncached = costNanos(strong, uncached, "sync");
    const sameModelUncachedSync = costNanos(g.model, uncached, "sync");
    const sameModelCachedSync = costNanos(g.model, usage, "sync");
    savedRouting += strongUncached - sameModelUncachedSync;
    savedCaching += sameModelUncachedSync - sameModelCachedSync;
    savedBatching += mode === "batch" ? sameModelCachedSync - costNanos(g.model, usage, "batch") : 0;
    return {
      model: g.model,
      mode,
      kind: g.kind,
      calls: num(g.calls),
      products: num(g.products),
      visionCalls: num(g.vision),
      inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      costNanos: cost,
    };
  });

  const coverage: Record<string, { translated: number; manual: number; outOfDate: number; failed: number; expected: number }> = {};
  const nonFailed = totalProducts - products.failed - products.pending;
  for (const locale of ["de", "fr"]) coverage[locale] = { translated: 0, manual: 0, outOfDate: 0, failed: 0, expected: nonFailed * 2 };
  for (const r of coverageRes.rows) {
    const c = coverage[r.locale];
    if (!c) continue;
    if (r.status === "machine") c.translated += num(r.n);
    if (r.status === "manual") c.manual += num(r.n);
    if (r.status === "out_of_date") c.outOfDate += num(r.n);
    if (r.status === "failed") c.failed += num(r.n);
  }

  const outcomes: Record<string, number> = {};
  for (const r of outcomeRes.rows) outcomes[r.outcome] = num(r.n);
  const speed = speedRes.rows[0];

  return {
    products: { ...products, total: totalProducts, processed },
    rows: { ...rows, total: Object.values(rows).reduce((a, b) => a + b, 0) },
    cost: {
      actualNanos: actual,
      baselineNanos: baseline,
      savedNanos: baseline - actual,
      savedRoutingNanos: savedRouting,
      savedBatchingNanos: savedBatching,
      savedCachingNanos: savedCaching,
      perProductNanos: processed ? Math.round(actual / processed) : 0,
    },
    models,
    costOverTime: timeRes.rows.map((r) => ({ bucket: new Date(r.bucket).toISOString(), costNanos: num(r.cost), baselineNanos: num(r.baseline), calls: num(r.calls) })),
    speed: {
      avgMs: Math.round(num(speed?.avg)),
      p50Ms: Math.round(num(speed?.p50)),
      p95Ms: Math.round(num(speed?.p95)),
      maxMs: Math.round(num(speed?.max)),
      slowest: slowRes.rows.map((r) => ({ id: r.id, handle: r.handle, title: r.title, ms: num(r.processing_ms), model: r.model })),
    },
    imports: importRes.rows.map((r) => ({
      id: r.id,
      fileName: r.file_name,
      rows: num(r.total_rows),
      seconds: Math.round(num(r.seconds)),
      rowsPerSecond: num(r.seconds) > 0 ? Math.round((num(r.total_rows) / num(r.seconds)) * 10) / 10 : 0,
      status: r.status,
      mode: r.mode,
      costNanos: num(r.cost),
    })),
    translation: coverage,
    outOfDate: Object.values(coverage).reduce((a, c) => a + c.outOfDate, 0),
    claims: { kept: num(claimRes.rows[0]?.kept), dropped: num(claimRes.rows[0]?.dropped), productsWithDropped: num(claimRes.rows[0]?.products_with_dropped) },
    aiOutcomes: outcomes,
  };
}
export type Metrics = Awaited<ReturnType<typeof getMetrics>>;
