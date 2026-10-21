import { and, asc, gt, inArray, isNull, type SQL } from "drizzle-orm";
import type { CatalogProduct } from "@/lib/ai/schema";
import { getDb, schema } from "@/lib/db/client";

const PAGE = 500;

export type ExportScope = "approved" | "reviewed" | "all";

export interface ExportedProduct extends CatalogProduct {
  translations?: Record<string, { title?: string; description_html?: string; status: Record<string, string> }>;
}

/** Streams products in the exact catalog JSON shape, page by page (constant memory). */
export async function* exportProducts(scope: ExportScope, withTranslations: boolean): AsyncGenerator<ExportedProduct> {
  const db = getDb();
  const statuses: Array<"approved" | "done" | "needs_review"> =
    scope === "approved" ? ["approved"] : scope === "reviewed" ? ["approved", "done"] : ["approved", "done", "needs_review"];
  let cursor: string | null = null;
  for (;;) {
    const conds: SQL[] = [inArray(schema.products.status, statuses), isNull(schema.products.deletedAt)];
    if (cursor) conds.push(gt(schema.products.id, cursor));
    const page = await db.select().from(schema.products).where(and(...conds)).orderBy(asc(schema.products.id)).limit(PAGE);
    if (!page.length) return;
    cursor = page[page.length - 1].id;
    const ids = page.map((p) => p.id);
    const [variants, translations] = await Promise.all([
      db.select().from(schema.variants).where(inArray(schema.variants.productId, ids)).orderBy(asc(schema.variants.position)),
      withTranslations ? db.select().from(schema.translations).where(inArray(schema.translations.productId, ids)) : Promise.resolve([]),
    ]);
    for (const p of page) {
      const out: ExportedProduct = {
        title: p.title ?? "",
        handle: p.handle,
        description_html: p.descriptionHtml ?? "",
        category: p.category ?? "",
        tags: p.tags,
        attributes: p.attributes,
        variants: variants
          .filter((v) => v.productId === p.id)
          .map((v) => ({ sku: v.sku, options: v.options, price_cents: v.priceCents, currency: v.currency, weight_grams: v.weightGrams })),
        claims: p.claims.map(({ text, source }) => ({ text, source })),
        confidence: p.confidence,
        status: p.status === "needs_review" ? "needs_review" : "done",
        review_reason: p.reviewReason,
        source_rows: p.sourceRows,
      };
      if (withTranslations) {
        out.translations = {};
        for (const t of translations.filter((x) => x.productId === p.id)) {
          const entry = (out.translations[t.locale] ??= { status: {} });
          if (t.field === "title") entry.title = t.text;
          else entry.description_html = t.text;
          entry.status[t.field === "title" ? "title" : "description_html"] = t.status;
        }
      }
      yield out;
    }
  }
}

const CSV_HEADERS = [
  "handle", "title", "status", "category", "tags", "sku", "options", "price_cents", "currency", "weight_grams",
  "description_html", "claims", "review_reason", "source_rows", "title_de", "title_fr",
];

function cell(v: unknown): string {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  // Neutralise spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One CSV row per variant (the shape most storefront importers expect). */
export async function* exportCsv(scope: ExportScope): AsyncGenerator<string> {
  yield CSV_HEADERS.join(",") + "\n";
  for await (const p of exportProducts(scope, true)) {
    for (const v of p.variants) {
      yield [
        p.handle, p.title, p.status, p.category, p.tags.join("; "), v.sku,
        Object.entries(v.options).map(([k, val]) => `${k}=${val}`).join("; "),
        v.price_cents, v.currency, v.weight_grams, p.description_html,
        p.claims.map((c) => `${c.text} [${c.source}]`).join(" | "), p.review_reason, p.source_rows.join(" "),
        p.translations?.de?.title, p.translations?.fr?.title,
      ].map(cell).join(",") + "\n";
    }
  }
}
