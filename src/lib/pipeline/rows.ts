import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";

/**
 * Copies product outcomes onto this import's rows. Rows of products that are still pending are
 * untouched, so the call is idempotent and safe to repeat after a crash.
 */
export async function syncRowStatuses(db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0], importId: string, productIds: string[]): Promise<void> {
  if (!productIds.length) return;
  await db.execute(sql`
    UPDATE source_rows r SET
      status = CASE
        WHEN p.deleted_at IS NOT NULL THEN 'failed'::row_status
        ELSE CASE p.status
        WHEN 'needs_review' THEN 'needs_review'::row_status
        WHEN 'failed' THEN 'failed'::row_status
        ELSE 'done'::row_status END END,
      status_reason = CASE
        WHEN p.deleted_at IS NOT NULL THEN 'Product was deleted by the merchant, so this row was not imported'
        WHEN p.status IN ('needs_review', 'failed') THEN COALESCE(p.review_reason, 'Needs review')
        ELSE NULL END,
      updated_at = now()
    FROM products p
    WHERE r.product_id = p.id
      AND r.import_id = ${importId}
      AND p.id = ANY(${sql.param(productIds)}::uuid[])
      AND p.status <> 'pending'
  `);
}

export interface ImportCounts {
  total: number;
  pending: number;
  done: number;
  needsReview: number;
  failed: number;
}

export async function rowCounts(db: Db, importId: string): Promise<ImportCounts> {
  const res = await db.execute<{ total: string; pending: string; done: string; needs_review: string; failed: string }>(sql`
    SELECT count(*) AS total,
      count(*) FILTER (WHERE status = 'pending') AS pending,
      count(*) FILTER (WHERE status = 'done') AS done,
      count(*) FILTER (WHERE status = 'needs_review') AS needs_review,
      count(*) FILTER (WHERE status = 'failed') AS failed
    FROM source_rows WHERE import_id = ${importId}
  `);
  const r = res.rows[0];
  return {
    total: Number(r.total),
    pending: Number(r.pending),
    done: Number(r.done),
    needsReview: Number(r.needs_review),
    failed: Number(r.failed),
  };
}
