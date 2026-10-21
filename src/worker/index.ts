import type { Job } from "pg-boss";
import { runMigrations } from "@/lib/db/migrate";
import { closeDb } from "@/lib/db/client";
import { env } from "@/lib/env";
import { handleBatchPoll, handleBatchSubmit } from "@/lib/pipeline/batch";
import { handleBuild } from "@/lib/pipeline/build";
import { maybeFinalize } from "@/lib/pipeline/finalize";
import { handleIngest } from "@/lib/pipeline/ingest";
import { handleSweep } from "@/lib/pipeline/sweep";
import { handleWebhook } from "@/lib/pipeline/webhook";
import { ensureQueues, getBoss, QUEUES, stopBoss, type JobData } from "@/lib/queue";
import { handleTranslate } from "@/lib/translate/run";

const log = (...args: unknown[]) => console.log(new Date().toISOString(), "[worker]", ...args);

function wrap<Q extends keyof JobData>(name: Q, fn: (data: JobData[Q]) => Promise<unknown>) {
  return async (jobs: Job<JobData[Q]>[]) => {
    for (const job of jobs) {
      const started = Date.now();
      try {
        await fn(job.data);
        if (name !== QUEUES.sweep) log(name, "ok", `${Date.now() - started}ms`);
      } catch (err) {
        log(name, "error", (err as Error).message);
        throw err;
      }
    }
  };
}

export async function startWorker(opts: { migrate?: boolean; closeDbOnStop?: boolean } = {}): Promise<() => Promise<void>> {
  if (opts.migrate !== false) await runMigrations();
  await ensureQueues();
  const boss = await getBoss();
  const concurrency = env().WORKER_CONCURRENCY;
  const polling = { pollingIntervalSeconds: 0.5 };
  await boss.work(QUEUES.ingest, { ...polling, localConcurrency: 2 }, wrap(QUEUES.ingest, (d) => handleIngest(d.importId)));
  await boss.work(QUEUES.build, { ...polling, localConcurrency: concurrency }, wrap(QUEUES.build, handleBuild));
  await boss.work(QUEUES.batchSubmit, { ...polling, localConcurrency: 1 }, wrap(QUEUES.batchSubmit, handleBatchSubmit));
  await boss.work(QUEUES.batchPoll, { ...polling, localConcurrency: 2 }, wrap(QUEUES.batchPoll, handleBatchPoll));
  await boss.work(QUEUES.translate, { ...polling, localConcurrency: Math.max(1, Math.floor(concurrency / 2)) }, wrap(QUEUES.translate, handleTranslate));
  await boss.work(QUEUES.finalize, { ...polling, localConcurrency: 1 }, wrap(QUEUES.finalize, (d) => maybeFinalize(d.importId)));
  await boss.work(QUEUES.webhook, { ...polling, localConcurrency: 2 }, wrap(QUEUES.webhook, handleWebhook));
  await boss.work(QUEUES.sweep, { pollingIntervalSeconds: 2, localConcurrency: 1 }, wrap(QUEUES.sweep, async () => {
    const { resumed } = await handleSweep();
    if (resumed.length) log("sweep resumed", resumed.join(", "));
  }));
  // Cron in pg-boss is minute-granular; a timer gives a tighter safety net (the job itself is cheap).
  const sweepTimer = setInterval(() => {
    boss.send(QUEUES.sweep, {}, { singletonKey: "sweep" }).catch(() => undefined);
  }, 15_000);
  log(`started (provider=${env().AI_PROVIDER}, concurrency=${concurrency}, pid=${process.pid})`);

  return async () => {
    clearInterval(sweepTimer);
    await stopBoss();
    if (opts.closeDbOnStop !== false) await closeDb();
  };
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("src/worker/index.ts");
if (isMain) {
  startWorker()
    .then((stop) => {
      let stopping = false;
      const shutdown = async (signal: string) => {
        if (stopping) return;
        stopping = true;
        log(`${signal}: stopping gracefully`);
        await stop();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
