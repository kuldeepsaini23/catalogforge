import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { QUEUES, send } from "@/lib/queue";
import { rowCounts, type ImportCounts } from "./rows";

export interface Reconciliation extends ImportCounts {
  sheetRows: number | null;
  ok: boolean;
  problems: string[];
}

/** Checks that every sheet row is stored exactly once and ends Done, Needs review or Failed. */
export async function reconcile(importId: string): Promise<Reconciliation> {
  const db = getDb();
  const imp = await db.query.imports.findFirst({ where: eq(schema.imports.id, importId), columns: { totalRows: true } });
  const counts = await rowCounts(db, importId);
  const problems: string[] = [];
  const sheetRows = imp?.totalRows ?? null;
  if (sheetRows === null) problems.push("sheet row count unknown");
  else if (counts.total !== sheetRows) problems.push(`${counts.total} rows stored, sheet has ${sheetRows}`);
  if (counts.pending) problems.push(`${counts.pending} rows pending`);
  if (counts.done + counts.needsReview + counts.failed + counts.pending !== counts.total) problems.push("status counts do not add up");
  const dupes = await db.execute<{ n: string }>(sql`
    SELECT count(*) AS n FROM (
      SELECT row_number FROM source_rows WHERE import_id = ${importId} GROUP BY row_number HAVING count(*) > 1
    ) d`);
  if (Number(dupes.rows[0].n) > 0) problems.push("duplicate row numbers");
  return { ...counts, sheetRows, ok: problems.length === 0, problems };
}

/** Marks the import completed once nothing is pending. The DB trigger re-checks the invariant. */
export async function maybeFinalize(importId: string): Promise<boolean> {
  const db = getDb();
  const r = await reconcile(importId);
  if (!r.ok) return false;
  const res = await db
    .update(schema.imports)
    .set({ status: "completed", phase: null, pausedUntil: null, pauseReason: null, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.imports.id, importId), sql`${schema.imports.status} IN ('building', 'paused')`))
    .returning({ id: schema.imports.id });
  if (res.length && env().IMPORT_WEBHOOK_URL) {
    await send(QUEUES.webhook, { importId, event: "import.completed" }, { singletonKey: `webhook:${importId}:completed` });
  }
  return res.length > 0;
}
