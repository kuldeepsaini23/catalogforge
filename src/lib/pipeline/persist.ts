import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { assembleProduct } from "@/lib/ai/assemble";
import type { AiProductDraft } from "@/lib/ai/schema";
import { sha256, slugify } from "@/lib/cleaning/text";
import { getDb, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { syncRowStatuses } from "./rows";

export interface BuildMeta {
  model: string;
  route: "cheap" | "strong";
  /** Cost of the call(s) attributed to each product, nano-USD. */
  costPerProduct: number;
  inputTokensPerProduct: number;
  outputTokensPerProduct: number;
  startedAt: number;
}

export const EDITABLE_FIELDS = ["title", "descriptionHtml", "category", "tags", "attributes"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

async function uniqueHandle(tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0], title: string, stableKey: string, productId: string): Promise<string> {
  const base = slugify(title) || "product";
  const taken = await tx
    .select({ handle: schema.products.handle })
    .from(schema.products)
    .where(and(sql`(${schema.products.handle} = ${base} OR ${schema.products.handle} ~ ${`^${base}-[0-9]+$`})`, ne(schema.products.id, productId)));
  if (!taken.length) return base;
  const used = new Set(taken.map((t) => t.handle));
  for (let n = 2; n < 50; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${sha256(stableKey).slice(0, 6)}`;
}

/**
 * Writes validated AI results. Each product is its own transaction and is skipped if it was
 * already built for this content (idempotent under retries, duplicate jobs and crash-resume).
 */
export async function writeBuiltProducts(importId: string, drafts: Map<string, { productId: string; draft: AiProductDraft }>, meta: BuildMeta): Promise<string[]> {
  const db = getDb();
  const written: string[] = [];
  for (const { productId, draft } of drafts.values()) {
    const done = await db.transaction(async (tx) => {
      const [p] = await tx.select().from(schema.products).where(eq(schema.products.id, productId)).for("update");
      if (!p || p.status !== "pending" || !p.input) return false;

      const handle = p.handle.startsWith("pending-") ? await uniqueHandle(tx, draft.title, p.stableKey, p.id) : p.handle;
      const result = assembleProduct(p.input, draft, { handle, minConfidence: env().AI_MIN_CONFIDENCE });
      const reasons = [...result.reasons];

      // SKUs are globally unique: a SKU owned by another product is a conflict for a human.
      const skus = result.product.variants.map((v) => v.sku);
      const owned = await tx
        .select({ sku: schema.variants.sku, handle: schema.products.handle })
        .from(schema.variants)
        .innerJoin(schema.products, eq(schema.products.id, schema.variants.productId))
        .where(and(inArray(schema.variants.sku, skus), ne(schema.variants.productId, p.id)));
      const ownedSkus = new Set(owned.map((o) => o.sku));
      for (const o of owned) reasons.push(`SKU ${o.sku} already belongs to product "${o.handle}"`);

      if (skus.length) {
        await tx.delete(schema.variants).where(and(eq(schema.variants.productId, p.id), notInArray(schema.variants.sku, skus)));
      }
      const variantRows = result.product.variants
        .filter((v) => !ownedSkus.has(v.sku))
        .map((v, i) => ({
          productId: p.id,
          sku: v.sku,
          options: v.options,
          priceCents: v.price_cents,
          currency: v.currency,
          weightGrams: v.weight_grams,
          sourceRows: p.input!.variants.find((iv) => iv.sku === v.sku)?.rows ?? [],
          position: i,
        }));
      if (variantRows.length) {
        await tx
          .insert(schema.variants)
          .values(variantRows)
          .onConflictDoUpdate({
            target: schema.variants.sku,
            set: {
              options: sql`excluded.options`,
              priceCents: sql`excluded.price_cents`,
              currency: sql`excluded.currency`,
              weightGrams: sql`excluded.weight_grams`,
              sourceRows: sql`excluded.source_rows`,
              position: sql`excluded.position`,
              updatedAt: sql`now()`,
            },
            setWhere: sql`${schema.variants.productId} = excluded.product_id`,
          });
      }

      // A merchant's manual edit always wins over a rebuild.
      const edited = new Set(p.editedFields);
      const keep = <T>(field: EditableField, fresh: T, current: T): T => (edited.has(field) ? current : fresh);
      const title = keep("title", result.product.title, p.title ?? result.product.title);
      const descriptionHtml = keep("descriptionHtml", result.product.description_html, p.descriptionHtml ?? result.product.description_html);
      const status = reasons.length ? "needs_review" : "done";
      await tx
        .update(schema.products)
        .set({
          handle,
          status,
          reviewReason: reasons.length ? [...new Set(reasons)].join("; ").slice(0, 2000) : null,
          title,
          descriptionHtml,
          category: keep("category", result.product.category, p.category ?? result.product.category),
          tags: keep("tags", result.product.tags, p.tags),
          attributes: keep("attributes", result.product.attributes, p.attributes),
          claims: result.claims,
          droppedClaims: result.dropped,
          confidence: result.product.confidence,
          minConfidence: result.minConfidence,
          builtHash: p.contentHash,
          englishHash: sha256(`${title}\n${descriptionHtml}`),
          model: meta.model,
          route: meta.route,
          aiCostNanos: sql`${schema.products.aiCostNanos} + ${meta.costPerProduct}`,
          aiInputTokens: sql`${schema.products.aiInputTokens} + ${meta.inputTokensPerProduct}`,
          aiOutputTokens: sql`${schema.products.aiOutputTokens} + ${meta.outputTokensPerProduct}`,
          processingMs: Date.now() - meta.startedAt,
          builtAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.products.id, p.id));
      return true;
    });
    if (done) written.push(productId);
  }
  await syncRowStatuses(db, importId, [...drafts.values()].map((d) => d.productId));
  return written;
}

export async function failProducts(importId: string, productIds: string[], reason: string): Promise<void> {
  if (!productIds.length) return;
  const db = getDb();
  await db
    .update(schema.products)
    .set({ status: "failed", reviewReason: reason.slice(0, 2000), lastError: reason.slice(0, 2000), updatedAt: new Date() })
    .where(and(inArray(schema.products.id, productIds), eq(schema.products.status, "pending")));
  await syncRowStatuses(db, importId, productIds);
}
