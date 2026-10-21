import { connection } from "next/server";
import { reconcile } from "@/lib/pipeline/finalize";
import { importDetail, rowStrip } from "@/lib/queries";
import { kickWorker } from "@/lib/serverless-worker";

const ACTIVE = new Set(["queued", "parsing", "building", "paused"]);
const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Server-Sent Events: pushes the import's status, per-row strip and reconciliation once a second
 * while it runs, then a final event and closes. Disconnects (tab closed) stop the loop.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/imports/[id]/events">) {
  await connection();
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "Import not found" }, { status: 404 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastPayload = "";
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = async () => {
        if (req.signal.aborted) return;
        try {
          const imp = await importDetail(id);
          if (!imp) {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "Import not found" })}\n\n`));
            controller.close();
            return;
          }
          const [strip, reconciliation] = await Promise.all([rowStrip(id), reconcile(id)]);
          void kickWorker(); // throttled; keeps a drain running while someone watches (Vercel only)
          const payload = JSON.stringify({ import: imp, strip, reconciliation });
          // Only send when something changed; a comment line keeps proxies from timing out.
          controller.enqueue(encoder.encode(payload === lastPayload ? ": keep-alive\n\n" : `data: ${payload}\n\n`));
          lastPayload = payload;
          if (!ACTIVE.has(imp.status)) {
            controller.close();
            return;
          }
          timer = setTimeout(push, 1000);
        } catch (err) {
          console.error(err);
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "Live updates stopped; reload the page" })}\n\n`));
          controller.close();
        }
      };
      req.signal.addEventListener("abort", () => clearTimeout(timer));
      await push();
    },
    cancel() {
      clearTimeout(timer);
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
