import { inArray, sql } from "drizzle-orm";
import { buildChunk, type AttemptLog } from "@/lib/ai/build";
import { FatalAiError, InvalidOutputError, RateLimitedError } from "@/lib/ai/errors";
import { baselineNanos, costNanos } from "@/lib/ai/pricing";
import { getProvider } from "@/lib/ai/provider";
import type { AiProductDraft } from "@/lib/ai/schema";
import { getDb, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { QUEUES, send, type JobData } from "@/lib/queue";
import { maybeFinalize } from "./finalize";
import { pauseImport, pausedUntil } from "./pause";
import { failProducts, writeBuiltProducts } from "./persist";
import { syncRowStatuses } from "./rows";

/** A product that keeps failing is marked Failed instead of retrying forever. */
export const MAX_BUILD_ATTEMPTS = 6;

export async function logAiCall(
  importId: string | null,
  kind: "build" | "translate",
  model: string,
  mode: "sync" | "batch",
  log: AttemptLog,
  vision = false,
): Promise<number> {
  const cost = costNanos(model, log.usage, mode);
  await getDb()
    .insert(schema.aiCalls)
    .values({
      importId,
      kind,
      model,
      mode,
      productCount: log.productCount,
      inputTokens: log.usage.inputTokens,
      outputTokens: log.usage.outputTokens,
      cacheReadTokens: log.usage.cacheReadTokens,
      cacheWriteTokens: log.usage.cacheWriteTokens,
      costNanos: cost,
      baselineNanos: baselineNanos(env().AI_MODEL_STRONG, log.usage),
      latencyMs: log.latencyMs,
      outcome: log.outcome,
      error: log.error?.slice(0, 1000),
      vision,
    });
  return cost;
}

/** product.build: one model call for a chunk of products (same route). */
export async function handleBuild(data: JobData[typeof QUEUES.build]): Promise<void> {
  const db = getDb();
  const { importId } = data;
  const until = await pausedUntil(importId);
  if (until) {
    await send(QUEUES.build, data, { startAfter: until });
    return;
  }

  const rows = await db.select().from(schema.products).where(inArray(schema.products.id, data.productIds));
  const todo = rows.filter((p) => p.status === "pending" && p.input && !p.deletedAt);
  const alreadyBuilt = rows.filter((p) => p.status !== "pending").map((p) => p.id);
  if (alreadyBuilt.length) await syncRowStatuses(db, importId, alreadyBuilt);
  if (!todo.length) {
    await maybeFinalize(importId);
    return;
  }

  // Give up on products that keep failing (e.g. the provider rejects them outright).
  const exhausted = todo.filter((p) => p.buildAttempts >= MAX_BUILD_ATTEMPTS);
  if (exhausted.length) {
    for (const p of exhausted) await failProducts(importId, [p.id], `AI build failed after ${p.buildAttempts} attempts: ${p.lastError ?? "unknown error"}`);
  }
  const live = todo.filter((p) => p.buildAttempts < MAX_BUILD_ATTEMPTS);
  if (!live.length) {
    await maybeFinalize(importId);
    return;
  }
  await db
    .update(schema.products)
    .set({ buildAttempts: sql`${schema.products.buildAttempts} + 1` })
    .where(inArray(schema.products.id, live.map((p) => p.id)));

  const model = data.route === "cheap" ? env().AI_MODEL_CHEAP : env().AI_MODEL_STRONG;
  const provider = await getProvider();
  const startedAt = Date.now();
  let cost = 0;
  let inTok = 0;
  let outTok = 0;
  let drafts: Map<string, AiProductDraft>;
  try {
    drafts = await buildChunk(
      provider,
      { model, vision: data.vision, products: live.map((p) => ({ ...p.input!, ...(p.merchantNote ? { merchantNote: p.merchantNote } : {}) })) },
      {
        onAttempt: async (log) => {
          cost += await logAiCall(importId, "build", model, "sync", log, data.vision);
          inTok += log.usage.inputTokens + log.usage.cacheReadTokens + log.usage.cacheWriteTokens;
          outTok += log.usage.outputTokens;
        },
      },
    );
  } catch (err) {
    const message = (err as Error).message;
    await db.update(schema.products).set({ lastError: message.slice(0, 2000) }).where(inArray(schema.products.id, live.map((p) => p.id)));
    if (err instanceof RateLimitedError) {
      const resumeAt = await pauseImport(importId, err.retryAfterMs, `Rate limited by AI provider: ${message}`);
      await send(QUEUES.build, data, { startAfter: resumeAt });
      return;
    }
    if (err instanceof InvalidOutputError || err instanceof FatalAiError) {
      // Isolate the product that breaks the chunk: split and retry halves; a single product fails.
      if (live.length > 1) {
        const mid = Math.ceil(live.length / 2);
        await send(QUEUES.build, { ...data, productIds: live.slice(0, mid).map((p) => p.id) });
        await send(QUEUES.build, { ...data, productIds: live.slice(mid).map((p) => p.id) });
        return;
      }
      await failProducts(importId, [live[0].id], `AI build failed: ${message}`);
      await maybeFinalize(importId);
      return;
    }
    throw err; // transient: pg-boss retries the job with exponential backoff + jitter
  }

  const byKey = new Map(live.map((p) => [p.stableKey, p.id]));
  const entries = new Map<string, { productId: string; draft: AiProductDraft }>();
  for (const [key, draft] of drafts) {
    const productId = byKey.get(key);
    if (productId) entries.set(productId, { productId, draft });
  }
  const n = live.length;
  const written = await writeBuiltProducts(importId, entries, {
    model,
    route: data.route,
    costPerProduct: Math.round(cost / n),
    inputTokensPerProduct: Math.round(inTok / n),
    outputTokensPerProduct: Math.round(outTok / n),
    startedAt,
  });
  if (written.length) await send(QUEUES.translate, { importId, productIds: written });
  await maybeFinalize(importId);
}

/**
 * Retry / "send back": rebuilds products (optionally with a merchant note for the model). Rows keep
 * their last outcome until the rebuild lands, so a completed import stays reconciled meanwhile.
 */
/** Merchant-chosen model for a re-run, instead of the router's decision. */
export interface RouteOverride {
  route: "cheap" | "strong";
  vision: boolean;
}

export async function requeueProducts(productIds: string[], merchantNote?: string, override?: RouteOverride): Promise<number> {
  const db = getDb();
  const res = await db
    .update(schema.products)
    .set({
      status: "pending",
      builtHash: null,
      buildAttempts: 0,
      lastError: null,
      ...(merchantNote !== undefined ? { merchantNote } : {}),
      updatedAt: new Date(),
    })
    .where(inArray(schema.products.id, productIds))
    .returning({ id: schema.products.id, importId: schema.products.lastImportId });
  const byImport = new Map<string, string[]>();
  for (const r of res) if (r.importId) (byImport.get(r.importId) ?? byImport.set(r.importId, []).get(r.importId)!).push(r.id);
  const { enqueueBuilds } = await import("./ingest");
  for (const [importId, ids] of byImport) await enqueueBuilds(importId, ids, false, override);
  return res.length;
}
