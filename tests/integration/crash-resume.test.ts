import { spawn, type ChildProcess } from "node:child_process";
import { count, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate, toCsv } from "../../fixtures/generate";
import { cleanSheet } from "@/lib/cleaning";
import { getDb, schema } from "@/lib/db/client";
import { createImport } from "@/lib/imports";
import { reconcile } from "@/lib/pipeline/finalize";
import { parseSheet } from "@/lib/sheet";
import { resetDatabase, waitFor, waitForImport } from "./helpers";

const ROWS = 3000;
const fixture = generate(ROWS, 7, { photos: 0 });
const csv = new TextEncoder().encode(toCsv(fixture.headers, fixture.rows));
const children: ChildProcess[] = [];

/** Runs the real worker as a separate OS process so we can kill -9 it. */
function startWorkerProcess(): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "src/worker/index.ts"], {
    env: {
      ...process.env,
      // Slow the mock down so the kill reliably lands mid-import.
      MOCK_LATENCY_MS: "60",
      WORKER_CONCURRENCY: "2",
      AI_PRODUCTS_PER_CALL_CHEAP: "4",
      AI_PRODUCTS_PER_CALL_STRONG: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (d) => process.stderr.write(`[worker ${child.pid}] ${d}`));
  children.push(child);
  return child;
}

function kill9(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

async function finishedRows(importId: string): Promise<number> {
  const r = await reconcile(importId);
  return r.done + r.needsReview + r.failed;
}

beforeAll(async () => {
  await resetDatabase();
});
afterAll(async () => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
});

describe("crash and resume", () => {
  it("survives two kill -9s mid-import: nothing lost, nothing doubled, counts add up", async () => {
    const { id } = await createImport({ name: "crash.csv", bytes: csv }, []);

    // 1st run: kill once some (but far from all) rows are finished.
    let worker = startWorkerProcess();
    await waitFor(async () => (await finishedRows(id)) >= ROWS * 0.15, { timeoutMs: 120_000, intervalMs: 100, label: "15% progress" });
    await kill9(worker);
    const atFirstKill = await finishedRows(id);
    expect(atFirstKill).toBeLessThan(ROWS);

    // 2nd run: kill again shortly after it resumes.
    worker = startWorkerProcess();
    await waitFor(async () => (await finishedRows(id)) > atFirstKill + 100, { timeoutMs: 120_000, intervalMs: 100, label: "progress after restart" });
    await kill9(worker);
    const atSecondKill = await finishedRows(id);
    expect(atSecondKill).toBeLessThan(ROWS);

    // 3rd run: let it finish. Dead jobs are detected via missed heartbeats and retried.
    worker = startWorkerProcess();
    const imp = await waitForImport(id, 240_000);
    expect(imp.status).toBe("completed");

    // Every sheet row exists exactly once and ended Done / Needs review / Failed.
    const r = await reconcile(id);
    expect(r.ok).toBe(true);
    expect(r.total).toBe(ROWS);
    expect(r.done + r.needsReview + r.failed).toBe(ROWS);

    // Exactly one product per supplier product (ground truth from the pure cleaner), no duplicates.
    const parsed = parseSheet(csv, "crash.csv");
    const expected = cleanSheet(parsed.headers, parsed.rows).groups.length;
    const db = getDb();
    const [{ n: products }] = await db.select({ n: count() }).from(schema.products);
    expect(products).toBe(expected);
    const dupSkus = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM (SELECT sku FROM variants GROUP BY sku HAVING count(*) > 1) d`);
    expect(Number(dupSkus.rows[0].n)).toBe(0);
    const unbuilt = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM products WHERE status = 'pending' OR (built_hash IS NULL AND status <> 'failed')`);
    expect(Number(unbuilt.rows[0].n)).toBe(0);

    // Work is not redone wholesale: AI calls stay close to the minimum (only in-flight chunks repeat).
    const calls = await db.execute<{ products: string }>(sql`SELECT coalesce(sum(product_count), 0) AS products FROM ai_calls WHERE kind = 'build' AND outcome = 'ok'`);
    expect(Number(calls.rows[0].products)).toBeLessThan(expected * 1.1);

    await kill9(worker);
  });
});
