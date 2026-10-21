import { and, asc, eq, gt, inArray, isNull, type SQL } from "drizzle-orm";
import type { CatalogProduct } from "@/lib/ai/schema";
import { getDb, schema } from "@/lib/db/client";
import { seoFields } from "@/lib/seo";
import { translatedAttributes, translatedTags } from "@/lib/translate/fields";

const PAGE = 500;

export type ExportScope = "approved" | "reviewed" | "all";

export interface ExportedProduct extends CatalogProduct {
  translations?: Record<string, { title?: string; description_html?: string; tags?: string[]; attributes?: Record<string, string>; status: Record<string, string> }>;
  /** Meta title/description per language (DE/FR only when translations are exported). */
  seo: Record<string, { meta_title: string; meta_description: string }>;
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
        seo: {},
      };
      const seo = (title: string, html: string) => {
        const s = seoFields(title, html, p.attributes.brand);
        return { meta_title: s.metaTitle, meta_description: s.metaDescription };
      };
      out.seo.en = seo(out.title, out.description_html);
      if (withTranslations) {
        out.translations = {};
        for (const t of translations.filter((x) => x.productId === p.id)) {
          const entry = (out.translations[t.locale] ??= { status: {} });
          const key = t.field === "descriptionHtml" ? "description_html" : t.field;
          if (t.field === "title") entry.title = t.text;
          else if (t.field === "descriptionHtml") entry.description_html = t.text;
          else if (t.field === "tags") entry.tags = translatedTags(t.text);
          else if (t.field === "attributes") entry.attributes = translatedAttributes(p.attributes, t.text);
          entry.status[key] = t.status;
        }
        // Same fallback as the storefront: a failed translation shows the English.
        for (const [locale, t] of Object.entries(out.translations)) {
          const ok = (field: "title" | "description_html") => t.status[field] !== "failed";
          out.seo[locale] = seo(ok("title") && t.title ? t.title : out.title, ok("description_html") && t.description_html ? t.description_html : out.description_html);
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

const SHOPIFY_HEADERS = [
  "Handle", "Title", "Body (HTML)", "Vendor", "Product Category", "Type", "Tags", "Published",
  "Option1 Name", "Option1 Value", "Option2 Name", "Option2 Value", "Option3 Name", "Option3 Value",
  "Variant SKU", "Variant Grams", "Variant Inventory Policy", "Variant Fulfillment Service", "Variant Price",
  "Variant Requires Shipping", "Variant Taxable", "Image Src", "Image Position", "Variant Weight Unit", "Status",
];

/** Minor units → "12.50" without floating point. */
export function decimalPrice(cents: number | null): string {
  if (cents === null) return "";
  const s = String(cents).padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

/**
 * Shopify's product CSV import format: one row per variant; product-level columns only on the
 * first row of each handle (as Shopify expects). Photos use absolute URLs to our photo route.
 */
export async function* exportShopifyCsv(scope: ExportScope, baseUrl: string): AsyncGenerator<string> {
  yield SHOPIFY_HEADERS.join(",") + "\n";
  const db = getDb();
  for await (const p of exportProducts(scope, false)) {
    const [row] = await db.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.handle, p.handle));
    const photos = row ? await db.select({ id: schema.photos.id }).from(schema.photos).where(eq(schema.photos.productId, row.id)) : [];
    const optionNames = [...new Set(p.variants.flatMap((v) => Object.keys(v.options)))].slice(0, 3);
    const label = (n: string) => n.charAt(0).toUpperCase() + n.slice(1);
    const lines = p.variants.map((v, i) => {
      const first = i === 0;
      const cells: Array<string | number> = [
        p.handle,
        first ? p.title : "",
        first ? p.description_html : "",
        first ? (p.attributes.brand ?? "") : "",
        first ? p.category : "",
        first ? (p.category.split(" > ").pop() ?? "") : "",
        first ? p.tags.join(", ") : "",
        first ? (p.status === "done" ? "TRUE" : "FALSE") : "",
        ...[0, 1, 2].flatMap((k) => (optionNames[k] ? [first ? label(optionNames[k]) : "", v.options[optionNames[k]] ?? ""] : ["", ""])),
        v.sku,
        v.weight_grams ?? "",
        "deny",
        "manual",
        decimalPrice(v.price_cents),
        "TRUE",
        "TRUE",
        photos[i] ? `${baseUrl}/api/photos/${photos[i].id}` : "",
        photos[i] ? i + 1 : "",
        "g",
        first ? (p.status === "done" ? "active" : "draft") : "",
      ];
      if (!optionNames.length) {
        cells[8] = first ? "Title" : "";
        cells[9] = "Default Title";
      }
      return cells.map(cell).join(",") + "\n";
    });
    yield lines.join("");
  }
}
