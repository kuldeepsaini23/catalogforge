import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { rowCounts } from "@/lib/pipeline/rows";

/** Fresh schema state for a test file: migrations applied, app tables and queue emptied. */
export async function resetDatabase(): Promise<void> {
  await runMigrations();
  const db = getDb();
  await db.execute(sql`TRUNCATE imports, source_rows, products, variants, photos, translations, translation_cache, ai_calls, ai_batches, storefront_products RESTART IDENTITY CASCADE`);
  await db.execute(sql`DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'pgboss' AND table_name = 'job') THEN EXECUTE 'DELETE FROM pgboss.job'; END IF; END $$`);
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, { timeoutMs = 120_000, intervalMs = 250, label = "condition" } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function waitForImport(importId: string, timeoutMs = 120_000) {
  const db = getDb();
  return waitFor(
    async () => {
      const imp = await db.query.imports.findFirst({ where: (t, { eq }) => eq(t.id, importId) });
      return imp && (imp.status === "completed" || imp.status === "failed") ? imp : null;
    },
    { timeoutMs, label: `import ${importId}` },
  );
}

/** Waits until no translate job is queued or running. */
export async function waitForQueueIdle(timeoutMs = 60_000): Promise<void> {
  const db = getDb();
  await waitFor(
    async () => {
      const r = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM pgboss.job WHERE state IN ('created','retry','active') AND name <> 'import-sweep'`);
      return Number(r.rows[0].n) === 0;
    },
    { timeoutMs, label: "idle queue" },
  );
}

export { rowCounts };
