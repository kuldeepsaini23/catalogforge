import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";

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

/** If the import is paused, returns when work may resume; clears an expired pause. */
export async function pausedUntil(importId: string): Promise<Date | null> {
  const db = getDb();
  const imp = await db.query.imports.findFirst({
    where: eq(schema.imports.id, importId),
    columns: { status: true, pausedUntil: true },
  });
  if (!imp || imp.status !== "paused" || !imp.pausedUntil) return null;
  if (imp.pausedUntil.getTime() > Date.now()) return imp.pausedUntil;
  await db
    .update(schema.imports)
    .set({ status: "building", pausedUntil: null, pauseReason: null, updatedAt: new Date() })
    .where(and(eq(schema.imports.id, importId), eq(schema.imports.status, "paused")));
  return null;
}
