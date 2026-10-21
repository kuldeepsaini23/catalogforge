import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate, toCsv } from "../../fixtures/generate";
import { InvalidOutputError, TRUNCATED } from "@/lib/ai/errors";
import { MockProvider } from "@/lib/ai/mock";
import { setProviderForTests, type CallResult, type TranslateRequest } from "@/lib/ai/provider";
import { getDb } from "@/lib/db/client";
import { createImport } from "@/lib/imports";
import { resetDatabase, waitForImport, waitForQueueIdle } from "./helpers";

/** Real models hit max_tokens on long DE/FR batches; here any call with more than 2 texts does. */
class TruncatingProvider extends MockProvider {
  override async translate(req: TranslateRequest): Promise<CallResult> {
    if (req.items.length > 2) {
      const err = new InvalidOutputError(TRUNCATED);
      err.usage = { inputTokens: 1_000, outputTokens: 4_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
      throw err;
    }
    return super.translate(req);
  }
}

let stop: () => Promise<void>;
beforeAll(async () => {
  await resetDatabase();
  setProviderForTests(new TruncatingProvider());
  const { startWorker } = await import("@/worker/index");
  stop = await startWorker();
});
afterAll(async () => {
  await stop?.();
  setProviderForTests(undefined);
});

describe("translation output cut off at max_tokens", () => {
  it("splits the batch until it fits, and bills the cut-off calls", async () => {
    const g = generate(40, 41, { photos: 0 });
    const { id } = await createImport({ name: "trunc.csv", bytes: new TextEncoder().encode(toCsv(g.headers, g.rows)) }, []);
    expect((await waitForImport(id)).status).toBe("completed");
    await waitForQueueIdle();

    const db = getDb();
    const tr = await db.execute<{ status: string; n: string }>(sql`SELECT status, count(*) AS n FROM translations GROUP BY status`);
    expect(tr.rows.map((r) => r.status)).toEqual(["machine"]);
    const cut = await db.execute<{ n: string; out: string }>(sql`
      SELECT count(*) AS n, coalesce(sum(output_tokens), 0) AS out FROM ai_calls WHERE kind = 'translate' AND outcome = 'invalid_output'`);
    expect(Number(cut.rows[0].n)).toBeGreaterThan(0);
    expect(Number(cut.rows[0].out)).toBe(Number(cut.rows[0].n) * 4_000);
  });
});
