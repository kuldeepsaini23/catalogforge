import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { generate, toCsv } from "../../fixtures/generate";
import { getDb } from "@/lib/db/client";
import { createImport } from "@/lib/imports";
import { reconcile } from "@/lib/pipeline/finalize";
import { drain } from "@/lib/serverless-worker";
import { resetDatabase } from "./helpers";

beforeAll(async () => {
  await resetDatabase();
  await getDb().execute(sql`DELETE FROM worker_lease`);
});

describe("serverless worker (Vercel): no always-on process", () => {
  it("a drain runs the queue to completion and only one drain runs at a time", async () => {
    const g = generate(120, 61, { photos: 0 });
    const { id } = await createImport({ name: "drain.csv", bytes: new TextEncoder().encode(toCsv(g.headers, g.rows)) }, []);

    const first = drain();
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await drain()).toEqual({ ran: false, remaining: -1 }); // lease held by the first

    const result = await first;
    expect(result.ran).toBe(true);
    const imp = await getDb().query.imports.findFirst({ where: (t, { eq }) => eq(t.id, id) });
    expect(imp?.status).toBe("completed");
    expect((await reconcile(id)).ok).toBe(true);
    // Lease released: the next drain may start.
    const lease = await getDb().execute<{ free: boolean }>(sql`SELECT until <= now() AS free FROM worker_lease WHERE id = 1`);
    expect(lease.rows[0].free).toBe(true);
  }, 120_000);
});
