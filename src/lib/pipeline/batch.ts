import { and, eq, inArray, sql } from "drizzle-orm";
import { parseBuildOutput } from "@/lib/ai/build";
import { RateLimitedError } from "@/lib/ai/errors";
import { getProvider } from "@/lib/ai/provider";
import { routeProduct } from "@/lib/ai/routing";
import type { AiProductDraft } from "@/lib/ai/schema";
import { getDb, schema } from "@/lib/db/client";
import type { BatchRequestEntry } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { QUEUES, send, type JobData } from "@/lib/queue";
import { logAiCall } from "./build";
import { maybeFinalize } from "./finalize";
import { pauseImport, pausedUntil } from "./pause";
import { writeBuiltProducts } from "./persist";

function pollDelayMs(): number {
  return env().AI_PROVIDER === "mock" ? Math.max(500, Math.round(env().MOCK_BATCH_DELAY_MS / 2)) : 60_000;
}

/**
 * import.batch-submit: all pending products of a large import go to the Message Batches API
 * (50% cheaper). The batch row is written BEFORE submission so a restart knows about it.
 */
export async function handleBatchSubmit(data: JobData[typeof QUEUES.batchSubmit]): Promise<void> {
  const db = getDb();
  const { importId } = data;
  const until = await pausedUntil(importId);
  if (until) {
    await send(QUEUES.batchSubmit, data, { startAfter: until, singletonKey: `batch-submit:${importId}` });
    return;
  }
  const existing = await db.select().from(schema.aiBatches).where(eq(schema.aiBatches.importId, importId));
  const covered = new Set(
    existing.filter((b) => b.status !== "failed").flatMap((b) => Object.values(b.requests).flatMap((r) => r.productIds)),
  );
  const pending = (
    await db
      .select({ id: schema.products.id, input: schema.products.input, key: schema.products.stableKey })
      .from(schema.products)
      .where(and(eq(schema.products.lastImportId, importId), eq(schema.products.status, "pending")))
  ).filter((p) => !covered.has(p.id) && p.input);
  if (!pending.length) {
    for (const b of existing.filter((x) => x.status === "in_progress")) {
      await send(QUEUES.batchPoll, { importId, batchRowId: b.id });
    }
    await maybeFinalize(importId);
    return;
  }

  const buckets = new Map<string, typeof pending>();
  for (const p of pending) {
    const d = routeProduct(p.input!);
    const k = `${d.route}:${d.vision}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(p);
  }
  const requests: Record<string, BatchRequestEntry> = {};
  let n = 0;
  for (const [k, items] of buckets) {
    const [route, vision] = k.split(":") as ["cheap" | "strong", string];
    const size = route === "cheap" ? env().AI_PRODUCTS_PER_CALL_CHEAP : env().AI_PRODUCTS_PER_CALL_STRONG;
    const model = route === "cheap" ? env().AI_MODEL_CHEAP : env().AI_MODEL_STRONG;
    for (let i = 0; i < items.length; i += size) {
      requests[`req-${n++}`] = { productIds: items.slice(i, i + size).map((p) => p.id), model, route, vision: vision === "true" };
    }
  }
  const [row] = await db.insert(schema.aiBatches).values({ importId, status: "submitting", requests }).returning();
  const inputs = new Map(pending.map((p) => [p.id, p.input!]));
  const provider = await getProvider();
  try {
    const batchId = await provider.submitBatch(
      Object.entries(requests).map(([customId, r]) => ({
        customId,
        request: { model: r.model, vision: Boolean(r.vision), products: r.productIds.map((id) => inputs.get(id)!) },
      })),
    );
    await db.update(schema.aiBatches).set({ providerBatchId: batchId, status: "in_progress", updatedAt: new Date() }).where(eq(schema.aiBatches.id, row.id));
  } catch (err) {
    await db.update(schema.aiBatches).set({ status: "failed", error: (err as Error).message, updatedAt: new Date() }).where(eq(schema.aiBatches.id, row.id));
    if (err instanceof RateLimitedError) {
      const at = await pauseImport(importId, err.retryAfterMs, `Rate limited by AI provider: ${err.message}`);
      await send(QUEUES.batchSubmit, data, { startAfter: at });
      return;
    }
    throw err;
  }
  await db.update(schema.imports).set({ phase: `Batch submitted (${Object.keys(requests).length} requests, ${pending.length} products)`, updatedAt: new Date() }).where(eq(schema.imports.id, importId));
  await send(QUEUES.batchPoll, { importId, batchRowId: row.id }, { startAfter: new Date(Date.now() + pollDelayMs()) });
}

/** import.batch-poll: waits for the batch to end, then applies each result exactly once. */
export async function handleBatchPoll(data: JobData[typeof QUEUES.batchPoll]): Promise<void> {
  const db = getDb();
  const [row] = await db.select().from(schema.aiBatches).where(eq(schema.aiBatches.id, data.batchRowId));
  if (!row || row.status === "applied" || row.status === "failed" || !row.providerBatchId) return;
  const provider = await getProvider();
  const status = await provider.batchStatus(row.providerBatchId);
  if (status !== "ended") {
    await send(QUEUES.batchPoll, data, { startAfter: new Date(Date.now() + pollDelayMs()) });
    return;
  }
  await db.update(schema.aiBatches).set({ status: "ended", updatedAt: new Date() }).where(eq(schema.aiBatches.id, row.id));

  const fallback: Array<{ ids: string[]; route: "cheap" | "strong"; vision: boolean }> = [];
  const translated: string[] = [];
  for await (const result of provider.batchResults(row.providerBatchId)) {
    const req = row.requests[result.customId];
    if (!req || req.applied) continue;
    const products = await db
      .select({ id: schema.products.id, key: schema.products.stableKey, status: schema.products.status })
      .from(schema.products)
      .where(inArray(schema.products.id, req.productIds));
    const keys = products.map((p) => p.key);
    let drafts: Map<string, AiProductDraft> | null = null;
    let error = result.ok ? undefined : result.error;
    if (result.ok) {
      try {
        drafts = parseBuildOutput(result.output, keys);
      } catch (err) {
        error = (err as Error).message;
      }
    }
    const usage = result.ok ? result.usage : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const cost = await logAiCall(data.importId, "build", req.model, "batch", {
      usage,
      latencyMs: 0,
      outcome: drafts ? "ok" : error?.startsWith("errored") ? "error" : "invalid_output",
      error,
      productCount: keys.length,
    }, Boolean(req.vision));
    if (drafts) {
      const byKey = new Map(products.map((p) => [p.key, p.id]));
      const entries = new Map<string, { productId: string; draft: AiProductDraft }>();
      for (const [key, draft] of drafts) entries.set(byKey.get(key)!, { productId: byKey.get(key)!, draft });
      const n = Math.max(1, keys.length);
      const written = await writeBuiltProducts(data.importId, entries, {
        model: req.model,
        route: req.route,
        costPerProduct: Math.round(cost / n),
        inputTokensPerProduct: Math.round((usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens) / n),
        outputTokensPerProduct: Math.round(usage.outputTokens / n),
        startedAt: row.createdAt.getTime(),
      });
      translated.push(...written);
    } else {
      // Errored/expired/invalid batch entries fall back to the synchronous path (retries + splitting).
      fallback.push({ ids: products.filter((p) => p.status === "pending").map((p) => p.id), route: req.route, vision: Boolean(req.vision) });
    }
    await db.execute(sql`
      UPDATE ai_batches SET requests = jsonb_set(requests, ${`{${result.customId},applied}`}::text[], 'true'::jsonb), updated_at = now()
      WHERE id = ${row.id}`);
  }
  for (const f of fallback) if (f.ids.length) await send(QUEUES.build, { importId: data.importId, productIds: f.ids, route: f.route, vision: f.vision });
  for (let i = 0; i < translated.length; i += 20) {
    await send(QUEUES.translate, { importId: data.importId, productIds: translated.slice(i, i + 20) });
  }
  await db.update(schema.aiBatches).set({ status: "applied", updatedAt: new Date() }).where(eq(schema.aiBatches.id, row.id));
  // Products added to the import after submission (e.g. retries) get their own batch.
  await send(QUEUES.batchSubmit, { importId: data.importId }, { singletonKey: `batch-submit:${data.importId}` });
  await maybeFinalize(data.importId);
}
