import { and, eq, inArray } from "drizzle-orm";
import { getDb, getPool, schema } from "@/lib/db/client";
import { notifyStorefront } from "@/lib/storefront-sync";
import type { StorefrontData } from "@/lib/db/schema";
import { TARGET_LOCALES } from "@/lib/translate/locales";

/**
 * Builds the published snapshot for products: English copy, translations (manual edits and
 * out-of-date edits included; failed translations fall back to English), variants and photos.
 * Storefront pages read only this table, never the working catalog, and never call the AI.
 */
async function snapshot(productIds: string[]) {
  const db = getDb();
  const [products, variants, photos, translations] = await Promise.all([
    db.select().from(schema.products).where(inArray(schema.products.id, productIds)),
    db.select().from(schema.variants).where(inArray(schema.variants.productId, productIds)),
    db.select({ productId: schema.photos.productId, id: schema.photos.id }).from(schema.photos).where(inArray(schema.photos.productId, productIds)),
    db.select().from(schema.translations).where(inArray(schema.translations.productId, productIds)),
  ]);
  return products.map((p) => {
    const tr = (locale: string, field: string) =>
      translations.find((t) => t.productId === p.id && t.locale === locale && t.field === field && t.status !== "failed")?.text;
    const en = { title: p.title ?? p.handle, descriptionHtml: p.descriptionHtml ?? "", tags: p.tags };
    const locales: StorefrontData["locales"] = { en };
    for (const l of TARGET_LOCALES) {
      locales[l] = { title: tr(l, "title") ?? en.title, descriptionHtml: tr(l, "descriptionHtml") ?? en.descriptionHtml, tags: p.tags };
    }
    const vs = variants.filter((v) => v.productId === p.id).sort((a, b) => a.position - b.position);
    const prices = vs.map((v) => v.priceCents).filter((c): c is number => c !== null);
    const data: StorefrontData = {
      locales,
      variants: vs.map((v) => ({ sku: v.sku, options: v.options, priceCents: v.priceCents, currency: v.currency, weightGrams: v.weightGrams })),
      photos: photos.filter((ph) => ph.productId === p.id).map((ph) => ph.id).slice(0, 8),
      attributes: p.attributes,
    };
    return {
      handle: p.handle,
      productId: p.id,
      category: p.category ?? "Uncategorised",
      data,
      priceMinCents: prices.length ? Math.min(...prices) : null,
      currency: vs.find((v) => v.currency)?.currency ?? null,
    };
  });
}

export interface PublishResult {
  published: string[];
  skipped: Array<{ id: string; reason: string }>;
  handles: string[];
  categories: string[];
}

/** Approve = publish a snapshot. Products without a price on every variant cannot be published. */
export async function approveProducts(productIds: string[]): Promise<PublishResult> {
  const db = getDb();
  const candidates = await db
    .select({ id: schema.products.id, status: schema.products.status, title: schema.products.title, deletedAt: schema.products.deletedAt })
    .from(schema.products)
    .where(inArray(schema.products.id, productIds));
  const variants = await db.select({ productId: schema.variants.productId, priceCents: schema.variants.priceCents }).from(schema.variants).where(inArray(schema.variants.productId, productIds));
  const skipped: PublishResult["skipped"] = [];
  const ok: string[] = [];
  for (const c of candidates) {
    const vs = variants.filter((v) => v.productId === c.id);
    if (c.deletedAt) skipped.push({ id: c.id, reason: "deleted" });
    else if (c.status === "pending" || c.status === "failed" || !c.title) skipped.push({ id: c.id, reason: `cannot approve a ${c.status} product` });
    else if (!vs.length) skipped.push({ id: c.id, reason: "no variants" });
    else if (vs.some((v) => v.priceCents === null)) skipped.push({ id: c.id, reason: "a variant has no price" });
    else ok.push(c.id);
  }
  if (!ok.length) return { published: [], skipped, handles: [], categories: [] };
  await db.update(schema.products).set({ status: "approved", approvedAt: new Date(), updatedAt: new Date() }).where(inArray(schema.products.id, ok));
  const rows = await snapshot(ok);
  await upsertSnapshots(rows);
  return { published: ok, skipped, handles: rows.map((r) => r.handle), categories: [...new Set(rows.map((r) => r.category))] };
}

const notify = (handles: string[], categories: string[]) =>
  notifyStorefront({ handles, categories }, (text, params) => getPool().query(text, params));

async function upsertSnapshots(rows: Awaited<ReturnType<typeof snapshot>>): Promise<void> {
  const db = getDb();
  for (const r of rows) {
    // A product's handle can change before approval; drop any stale snapshot under an old handle.
    await db.delete(schema.storefrontProducts).where(and(eq(schema.storefrontProducts.productId, r.productId)));
    await db.insert(schema.storefrontProducts).values({ ...r, publishedAt: new Date() });
  }
  if (rows.length) await notify(rows.map((r) => r.handle), [...new Set(rows.map((r) => r.category))]);
}

/** Re-snapshots already-approved products (e.g. after translations land). */
export async function refreshPublished(productIds: string[]): Promise<void> {
  if (!productIds.length) return;
  const approved = await getDb()
    .select({ id: schema.products.id })
    .from(schema.products)
    .where(and(inArray(schema.products.id, productIds), eq(schema.products.status, "approved")));
  if (approved.length) await upsertSnapshots(await snapshot(approved.map((a) => a.id)));
}

export async function unpublishProducts(productIds: string[]): Promise<string[]> {
  const res = await getDb()
    .delete(schema.storefrontProducts)
    .where(inArray(schema.storefrontProducts.productId, productIds))
    .returning({ handle: schema.storefrontProducts.handle, category: schema.storefrontProducts.category });
  if (res.length) await notify(res.map((r) => r.handle), [...new Set(res.map((r) => r.category))]);
  return res.map((r) => r.handle);
}
