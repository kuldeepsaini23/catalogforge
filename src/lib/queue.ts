import { PgBoss, type SendOptions } from "pg-boss";
import { env } from "@/lib/env";

export const QUEUES = {
  ingest: "import-ingest",
  build: "product-build",
  batchSubmit: "import-batch-submit",
  batchPoll: "import-batch-poll",
  translate: "product-translate",
  finalize: "import-finalize",
  sweep: "import-sweep",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface JobData {
  [QUEUES.ingest]: { importId: string };
  [QUEUES.build]: { importId: string; productIds: string[]; route: "cheap" | "strong"; vision: boolean };
  [QUEUES.batchSubmit]: { importId: string };
  [QUEUES.batchPoll]: { importId: string; batchRowId: string };
  [QUEUES.translate]: { importId: string | null; productIds: string[] };
  [QUEUES.finalize]: { importId: string };
  [QUEUES.sweep]: Record<string, never>;
}

const globalForBoss = globalThis as unknown as { __cfBoss?: Promise<PgBoss> };

async function create(): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: env().DATABASE_URL,
    max: 6,
    // Fast dead-worker detection: jobs heartbeat every 5s; the monitor fails+retries a job whose
    // heartbeat is >10s old. This is what makes kill -9 mid-import resume within ~20s.
    monitorIntervalSeconds: 5,
    superviseIntervalSeconds: 5,
  });
  boss.on("error", (err) => console.error("[pg-boss]", err.message));
  await boss.start();
  return boss;
}

/** One pg-boss instance per process (Next.js API routes and the worker). */
export function getBoss(): Promise<PgBoss> {
  if (!globalForBoss.__cfBoss) {
    globalForBoss.__cfBoss = create().catch((err) => {
      globalForBoss.__cfBoss = undefined;
      throw err;
    });
  }
  return globalForBoss.__cfBoss;
}

export async function stopBoss(): Promise<void> {
  const p = globalForBoss.__cfBoss;
  globalForBoss.__cfBoss = undefined;
  if (p) await (await p).stop({ graceful: true, timeout: 10_000 });
}

/**
 * Queue policy. Retries use pg-boss' exponential backoff with jitter; heartbeats let a crashed
 * worker's jobs be retried quickly. Handlers are idempotent, so a retried job never doubles data.
 */
export async function ensureQueues(): Promise<void> {
  const boss = await getBoss();
  const common = { retryLimit: 6, retryDelay: 2, retryBackoff: true, retryDelayMax: 120, heartbeatSeconds: 10 };
  for (const name of Object.values(QUEUES)) {
    const existing = await boss.getQueue(name);
    const opts = {
      ...common,
      expireInSeconds: name === QUEUES.ingest ? 1800 : 600,
      deleteAfterSeconds: 3 * 24 * 3600,
    };
    if (!existing) await boss.createQueue(name, opts);
    else await boss.updateQueue(name, opts);
  }
}

export async function send<Q extends keyof JobData>(name: Q, data: JobData[Q], options: SendOptions = {}): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(name, data as object, options);
}
