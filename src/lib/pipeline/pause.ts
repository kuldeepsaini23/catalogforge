import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { env } from "@/lib/env";

const BUDGET_RECHECK_MS = 15 * 60_000;
let spentCache: { at: number; nanos: number } | undefined;

/** AI spend over the last 24 h in nano-USD (cached for 10 s; every AI job asks). */
async function spentLastDay(): Promise<number> {
  if (spentCache && Date.now() - spentCache.at < 10_000) return spentCache.nanos;
  const r = await getDb().execute<{ n: string }>(sql`SELECT coalesce(sum(cost_nanos), 0) AS n FROM ai_calls WHERE created_at > now() - interval '24 hours'`);
  spentCache = { at: Date.now(), nanos: Number(r.rows[0].n) };
  return spentCache.nanos;
}

/** Pauses an import after a rate limit. Extends (never shortens) an existing pause. */
export async function pauseImport(importId: string, retryAfterMs: number, reason: string): Promise<Date> {
  const until = new Date(Date.now() + retryAfterMs);
  const db = getDb();
  await db
    .update(schema.imports)
    .set({
      status: "paused",
      pausedUntil: sql`GREATEST(COALESCE(${schema.imports.pausedUntil}, now()), ${until.toISOString()}::timestamptz)`,
      pauseReason: reason,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.imports.id, importId), sql`${schema.imports.status} IN ('building', 'paused')`));
  return until;
}

/**
 * If the import is paused, returns when work may resume; clears an expired pause. Every AI job
 * checks this first, so it is also where the daily AI budget is enforced.
 */
export async function pausedUntil(importId: string): Promise<Date | null> {
  const db = getDb();
  const imp = await db.query.imports.findFirst({
    where: eq(schema.imports.id, importId),
    columns: { status: true, pausedUntil: true },
  });
  if (!imp) return null;
  if (imp.status === "paused" && imp.pausedUntil) {
    if (imp.pausedUntil.getTime() > Date.now()) return imp.pausedUntil;
    await db
      .update(schema.imports)
      .set({ status: "building", pausedUntil: null, pauseReason: null, updatedAt: new Date() })
      .where(and(eq(schema.imports.id, importId), eq(schema.imports.status, "paused")));
  }
  const budget = env().AI_DAILY_BUDGET_USD;
  if (budget && (imp.status === "building" || imp.status === "paused") && (await spentLastDay()) >= budget * 1e9) {
    return pauseImport(importId, BUDGET_RECHECK_MS, `Daily AI budget of $${budget} reached; resumes when the last 24 h of spend drops below it`);
  }
  return null;
}
