/**
 * Scale + load benchmark (expects `bun run start` and `bun run worker` already running):
 *   1. imports the 5,000-row fixture and publishes everything that is ready (storefront content),
 *   2. starts the 10,000-row import and, at the same time, a k6 run against storefront pages,
 *   3. waits for the import to reconcile, then writes load/results/scale-run.json.
 *
 *   bun run fixtures && bun run scale-run
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const K6_DURATION = process.env.K6_DURATION ?? "90s";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
  return body as T;
}

async function upload(sheet: string, photos: string): Promise<string> {
  const form = new FormData();
  form.append("sheet", new Blob([readFileSync(sheet)]), sheet.split("/").pop());
  form.append("photos", new Blob([readFileSync(photos)]), photos.split("/").pop());
  const r = await api<{ id: string }>("/api/imports", { method: "POST", body: form });
  return r.id;
}

interface ImportState {
  import: { status: string; startedAt: string | null; finishedAt: string | null; totalRows: number | null; productsTotal: number | null; mode: string | null };
  reconciliation: { ok: boolean; total: number; done: number; needsReview: number; failed: number; pending: number };
}

async function waitDone(id: string, label: string): Promise<ImportState> {
  for (;;) {
    const s = await api<ImportState>(`/api/imports/${id}`);
    process.stdout.write(`\r${label}: ${s.import.status} ${s.reconciliation.total - s.reconciliation.pending}/${s.import.totalRows ?? "?"} rows   `);
    if (s.import.status === "completed" || s.import.status === "failed") {
      process.stdout.write("\n");
      return s;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function publishReady(): Promise<number> {
  let published = 0;
  for (;;) {
    const page = await api<{ items: Array<{ id: string }> }>(`/api/products?status=done&size=100`);
    if (!page.items.length) return published;
    const r = await api<{ approved: number }>("/api/products/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve", ids: page.items.map((i) => i.id) }),
    });
    published += r.approved;
    if (!r.approved) return published;
  }
}

function runK6(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("k6", ["run", "--quiet", "-e", `BASE_URL=${BASE}`, "-e", `DURATION=${K6_DURATION}`, "load/storefront.js"], { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main() {
  mkdirSync("load/results", { recursive: true });
  console.log("1/3 seeding the storefront with the 5,000-row fixture");
  const seedId = await upload("fixtures/out/supplier-5000.csv", "fixtures/out/supplier-5000-photos.zip");
  const seed = await waitDone(seedId, "seed import");
  const published = await publishReady();
  console.log(`published ${published} products`);

  console.log("2/3 starting the 10,000-row import and the k6 storefront load test together");
  const started = Date.now();
  const bigId = await upload("fixtures/out/supplier-10000.csv", "fixtures/out/supplier-10000-photos.zip");
  const uploadMs = Date.now() - started;
  const [k6Exit, big] = await Promise.all([runK6(), waitDone(bigId, "10k import")]);
  const k6 = JSON.parse(readFileSync("load/results/k6-summary.json", "utf8"));
  const metrics = await api<Record<string, unknown>>("/api/metrics");

  const seconds = (s: ImportState) => (new Date(s.import.finishedAt!).getTime() - new Date(s.import.startedAt!).getTime()) / 1000;
  const result = {
    at: new Date().toISOString(),
    seed: { rows: seed.import.totalRows, products: seed.import.productsTotal, seconds: seconds(seed), reconciliation: seed.reconciliation },
    big: { rows: big.import.totalRows, products: big.import.productsTotal, mode: big.import.mode, uploadResponseMs: uploadMs, seconds: seconds(big), reconciliation: big.reconciliation },
    k6: { exitCode: k6Exit, ...k6 },
    metrics,
  };
  writeFileSync("load/results/scale-run.json", JSON.stringify(result, null, 2));
  console.log("3/3 done → load/results/scale-run.json");
  console.log(JSON.stringify({ big: result.big, k6: result.k6 }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
