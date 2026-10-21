import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { QUEUES, send } from "@/lib/queue";
import { maybeFinalize, reconcile } from "./finalize";
import { syncRowStatuses } from "./rows";
import { enqueueBuilds } from "./ingest";

const STALE_MS = 45_000;

/** Count of live (queued/retrying/running) jobs whose data mentions the import. */
async function liveJobs(importId: string): Promise<number> {
  const res = await getDb().execute<{ n: string }>(sql`
    SELECT count(*) AS n FROM pgboss.job
    WHERE state IN ('created', 'retry', 'active')
      AND name <> ${QUEUES.sweep}
      AND data->>'importId' = ${importId}
  `);
  return Number(res.rows[0].n);
}

/**
 * Safety net for crash-resume: finds imports with work left but no live job (e.g. the process died
 * between a DB commit and the enqueue, or a job exhausted its retries) and re-enqueues it.
 * Everything it enqueues is idempotent, so a false positive costs nothing but a no-op job.
 */
export async function handleSweep(): Promise<{ resumed: string[] }> {
  const db = getDb();
  const resumed: string[] = [];
  const active = await db
    .select()
    .from(schema.imports)
    .where(and(inArray(schema.imports.status, ["queued", "parsing", "building", "paused"]), lt(schema.imports.updatedAt, new Date(Date.now() - STALE_MS))));
  for (const imp of active) {
    if (imp.status === "paused" && imp.pausedUntil && imp.pausedUntil.getTime() > Date.now()) continue;
    if ((await liveJobs(imp.id)) > 0) continue;
    if (imp.status === "queued" || imp.status === "parsing") {
      await send(QUEUES.ingest, { importId: imp.id }, { singletonKey: `ingest:${imp.id}` });
      resumed.push(imp.id);
      continue;
    }
    if (await maybeFinalize(imp.id)) continue;
    // Work left is derived from this import's pending rows (not products.last_import_id, which a
    // newer import of the same product may have taken over).
    const pendingRows = await db.execute<{ product_id: string | null; status: string | null }>(sql`
      SELECT DISTINCT r.product_id, p.status FROM source_rows r
      LEFT JOIN products p ON p.id = r.product_id
      WHERE r.import_id = ${imp.id} AND r.status = 'pending'`);
    const unlinked = pendingRows.rows.some((r) => r.product_id === null);
    const toBuild = pendingRows.rows.filter((r) => r.product_id && r.status === "pending").map((r) => r.product_id!);
    const toSync = pendingRows.rows.filter((r) => r.product_id && r.status !== "pending").map((r) => r.product_id!);
    if (toSync.length) await syncRowStatuses(db, imp.id, toSync);
    // Stuck "submitting" batches (crash during submission) are abandoned and the products re-sent.
    await db
      .update(schema.aiBatches)
      .set({ status: "failed", error: "abandoned: crashed during submission", updatedAt: new Date() })
      .where(and(eq(schema.aiBatches.importId, imp.id), eq(schema.aiBatches.status, "submitting")));
    const inFlight = await db
      .select({ id: schema.aiBatches.id })
      .from(schema.aiBatches)
      .where(and(eq(schema.aiBatches.importId, imp.id), inArray(schema.aiBatches.status, ["in_progress", "ended"])));
    for (const b of inFlight) await send(QUEUES.batchPoll, { importId: imp.id, batchRowId: b.id });
    if (toBuild.length && !inFlight.length) await enqueueBuilds(imp.id, toBuild, false);
    // Rows without a product link (crash between row insert and linking): re-run ingest.
    if (unlinked || (await reconcile(imp.id)).total !== imp.totalRows) {
      await send(QUEUES.ingest, { importId: imp.id }, { singletonKey: `ingest:${imp.id}` });
    }
    await maybeFinalize(imp.id);
    await db.update(schema.imports).set({ updatedAt: new Date() }).where(eq(schema.imports.id, imp.id));
    resumed.push(imp.id);
  }
  return { resumed };
}
