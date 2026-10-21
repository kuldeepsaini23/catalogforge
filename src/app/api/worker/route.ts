import { after, NextResponse } from "next/server";
import { drain, workerAuthorized } from "@/lib/serverless-worker";

// Vercel: the drain runs after the response, for up to the function's time limit.
export const maxDuration = 300;

/** Starts a queue drain (Vercel only). POST from kicks, GET from the daily cron; both carry CRON_SECRET. */
async function start(req: Request) {
  if (!workerAuthorized(req)) return NextResponse.json({ error: "Not authorized" }, { status: 401 });
  after(() => drain().then((r) => console.log("[worker] drain", r)).catch((err) => console.error("[worker] drain failed", err)));
  return NextResponse.json({ started: true }, { status: 202 });
}

export const POST = start;
export const GET = start;
