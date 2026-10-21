import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { QUEUES } from "@/lib/queue";

/**
 * The worker on Vercel. There is no always-on process there, so /api/worker runs the same pg-boss
 * handlers for up to DRAIN_MS, then calls itself again while work is left. A lease row keeps it to
 * one drain at a time. The queue lives in Postgres, so a drain that dies mid-job loses nothing: its
 * jobs' heartbeats stop, pg-boss retries them, and the next drain (started by any kick, or the
 * daily cron) picks them up. Self-hosted (`bun run worker`) none of this runs.
 */
export const DRAIN_MS = 270_000; // under the 300 s function limit, leaving time to stop cleanly
const LEASE_MS = 60_000;
const IDLE_CHECKS = 3;
const SOON_MS = 120_000; // jobs scheduled this soon (e.g. batch polls) keep the drain alive

export function isServerless(): boolean {
  return Boolean(process.env.VERCEL);
}

function selfUrl(): string | null {
  const host = process.env.PUBLIC_BASE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null);
  return host ? `${host.replace(/\/$/, "")}/api/worker` : null;
}

/** Shared secret for /api/worker (the Vercel cron sends it as a Bearer token). */
export function workerAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization") ?? "";
  if (!secret) return false;
  const given = Buffer.from(header.replace(/^Bearer /, ""));
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function acquireLease(holder: string): Promise<boolean> {
  const r = await getDb().execute(sql`
    INSERT INTO worker_lease (id, until, holder) VALUES (1, now() + ${`${LEASE_MS} milliseconds`}::interval, ${holder})
    ON CONFLICT (id) DO UPDATE SET until = excluded.until, holder = excluded.holder
    WHERE worker_lease.until < now() OR worker_lease.holder = ${holder}
    RETURNING id`);
  return r.rows.length > 0;
}

async function releaseLease(holder: string): Promise<void> {
  await getDb().execute(sql`UPDATE worker_lease SET until = now() WHERE id = 1 AND holder = ${holder}`);
}

async function leaseFree(): Promise<boolean> {
  const r = await getDb().execute<{ free: boolean }>(sql`SELECT coalesce((SELECT until < now() FROM worker_lease WHERE id = 1), true) AS free`);
  return r.rows[0].free;
}

/** Work the queue still holds: runnable now, running, or due soon. The sweep job doesn't count. */
async function pendingJobs(): Promise<{ now: number; soon: number }> {
  const r = await getDb().execute<{ now: string; soon: string }>(sql`
    SELECT count(*) FILTER (WHERE state = 'active' OR start_after <= now()) AS now,
           count(*) FILTER (WHERE start_after <= now() + ${`${SOON_MS} milliseconds`}::interval) AS soon
    FROM pgboss.job WHERE state IN ('created', 'retry', 'active') AND name <> ${QUEUES.sweep}`);
  return { now: Number(r.rows[0].now), soon: Number(r.rows[0].soon) };
}

let lastKick = 0;

/**
 * Starts a drain if none is running. Cheap and throttled; called after uploads, product actions and
 * while someone watches an import, so work never sits waiting for the daily cron.
 */
export async function kickWorker(force = false): Promise<void> {
  if (!isServerless()) return;
  if (!force && Date.now() - lastKick < 15_000) return;
  lastKick = Date.now();
  const url = selfUrl();
  if (!url || !process.env.CRON_SECRET) return;
  if (!(await leaseFree())) return;
  await fetch(url, { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(10_000) }).catch(() => {});
}

/** Runs the worker until the queue is idle or the time budget is spent; chains if work remains. */
export async function drain(): Promise<{ ran: boolean; remaining: number }> {
  const holder = crypto.randomUUID();
  if (!(await acquireLease(holder))) return { ran: false, remaining: -1 };
  const { startWorker } = await import("@/worker/index");
  const stop = await startWorker({ migrate: false, closeDbOnStop: false });
  const deadline = Date.now() + DRAIN_MS;
  let idle = 0;
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000));
      if (!(await acquireLease(holder))) break; // someone else took over (should not happen)
      const p = await pendingJobs();
      idle = p.now === 0 && p.soon === 0 ? idle + 1 : 0;
      if (idle >= IDLE_CHECKS) break;
    }
  } finally {
    await stop();
    await releaseLease(holder);
  }
  const remaining = (await pendingJobs()).soon;
  if (remaining > 0) await kickWorker(true);
  return { ran: true, remaining };
}
