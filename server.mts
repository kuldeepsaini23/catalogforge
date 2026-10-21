/**
 * Production web server: Next.js request handler in N processes sharing one port (node:cluster).
 * `next start` renders on a single thread; the storefront is CPU-bound on rendering, so this is
 * how it keeps up with traffic while an import runs. Cache invalidation across processes goes
 * through Postgres LISTEN/NOTIFY (see src/lib/storefront-sync.ts).
 *
 *   bun run build && bun run serve        # WEB_CONCURRENCY=4 by default
 */
import cluster from "node:cluster";
import { createServer } from "node:http";
import { availableParallelism } from "node:os";

// Must be set before Next loads.
(process.env as Record<string, string | undefined>).NODE_ENV ??= "production";
const { default: next } = await import("next");

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? "0.0.0.0";
const workers = Math.max(1, Number(process.env.WEB_CONCURRENCY ?? Math.min(4, Math.floor(availableParallelism() / 2))));

if (cluster.isPrimary && workers > 1) {
  console.log(`[web] starting ${workers} processes on :${port}`);
  for (let i = 0; i < workers; i++) cluster.fork();
  cluster.on("exit", (worker, code, signal) => {
    console.error(`[web] process ${worker.process.pid} exited (${signal ?? code}); restarting`);
    cluster.fork();
  });
} else {
  const app = next({ dev: false, hostname, port });
  const handle = app.getRequestHandler();
  await app.prepare();
  createServer((req, res) => handle(req, res)).listen(port, hostname, () => {
    console.log(`[web ${process.pid}] ready on http://localhost:${port}`);
  });
}
