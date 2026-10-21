import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import type { JobData, QUEUES } from "@/lib/queue";
import { rowCounts } from "./rows";

/**
 * POSTs an import summary to IMPORT_WEBHOOK_URL. Signed with HMAC-SHA256 of the body
 * (header X-CatalogForge-Signature) when IMPORT_WEBHOOK_SECRET is set. A non-2xx answer throws, so
 * pg-boss retries with exponential backoff.
 */
export async function handleWebhook(data: JobData[typeof QUEUES.webhook]): Promise<void> {
  const url = env().IMPORT_WEBHOOK_URL;
  if (!url) return;
  const db = getDb();
  const imp = await db.query.imports.findFirst({ where: eq(schema.imports.id, data.importId) });
  if (!imp) return;
  const counts = await rowCounts(db, data.importId);
  const body = JSON.stringify({
    event: data.event,
    import: { id: imp.id, fileName: imp.fileName, status: imp.status, totalRows: imp.totalRows, products: imp.productsTotal, error: imp.error, startedAt: imp.startedAt, finishedAt: imp.finishedAt },
    rows: { done: counts.done, needsReview: counts.needsReview, failed: counts.failed, total: counts.total },
    sentAt: new Date().toISOString(),
  });
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "CatalogForge-Webhook/1" };
  const secret = env().IMPORT_WEBHOOK_SECRET;
  if (secret) headers["X-CatalogForge-Signature"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Webhook ${url} answered ${res.status}`);
}
