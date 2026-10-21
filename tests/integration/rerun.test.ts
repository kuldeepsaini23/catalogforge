import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate, toCsv } from "../../fixtures/generate";
import { getDb, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { createImport } from "@/lib/imports";
import { requeueProducts } from "@/lib/pipeline/build";
import { resetDatabase, waitFor, waitForImport } from "./helpers";

let stop: () => Promise<void>;
beforeAll(async () => {
  await resetDatabase();
  const { startWorker } = await import("@/worker/index");
  stop = await startWorker();
});
afterAll(async () => {
  await stop?.();
});

describe("re-run AI with different settings", () => {
  it("rebuilds selected products with the model the merchant picked", async () => {
    const g = generate(40, 53, { photos: 0 });
    const { id } = await createImport({ name: "rerun.csv", bytes: new TextEncoder().encode(toCsv(g.headers, g.rows)) }, []);
    expect((await waitForImport(id)).status).toBe("completed");
    const db = getDb();
    const cheap = (await db.select().from(schema.products)).filter((p) => p.model === env().AI_MODEL_CHEAP).slice(0, 3);
    expect(cheap.length).toBe(3);

    const ids = cheap.map((p) => p.id);
    expect(await requeueProducts(ids, undefined, { route: "strong", vision: false })).toBe(3);
    const rebuilt = await waitFor(
      async () => {
        const rows = await db.select().from(schema.products).where(inArray(schema.products.id, ids));
        return rows.every((p) => p.status !== "pending") ? rows : null;
      },
      { label: "rebuild" },
    );
    expect(rebuilt.map((p) => p.model)).toEqual([env().AI_MODEL_STRONG, env().AI_MODEL_STRONG, env().AI_MODEL_STRONG]);
  });
});
