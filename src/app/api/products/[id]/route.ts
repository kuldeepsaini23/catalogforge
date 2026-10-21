import { eq } from "drizzle-orm";
import { after, connection, NextResponse } from "next/server";
import { z } from "zod";
import { handleError } from "@/lib/api";
import { sanitizeOutputHtml } from "@/lib/cleaning/html";
import { sha256 } from "@/lib/cleaning/text";
import { getDb, schema } from "@/lib/db/client";
import { refreshPublished, unpublishProducts } from "@/lib/publish";
import { productDetail } from "@/lib/queries";
import { QUEUES, send } from "@/lib/queue";
import { revalidateStorefront } from "@/lib/revalidate";
import { isValidCategory } from "@/lib/taxonomy";
import { kickWorker } from "@/lib/serverless-worker";

export async function GET(_req: Request, ctx: RouteContext<"/api/products/[id]">) {
  await connection();
  try {
    const { id } = await ctx.params;
    if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: "Product not found" }, { status: 404 });
    const detail = await productDetail(id);
    if (!detail) return NextResponse.json({ error: "Product not found" }, { status: 404 });
    return NextResponse.json(detail);
  } catch (err) {
    return handleError(err);
  }
}

const editSchema = z
  .object({
    title: z.string().trim().min(2).max(150),
    descriptionHtml: z.string().max(10_000),
    category: z.string().refine(isValidCategory, "Category must be one of the taxonomy paths"),
    tags: z.array(z.string().trim().min(1).max(40)).max(20),
    attributes: z.record(z.string(), z.string().max(300)),
  })
  .partial();

/**
 * Delete: unpublishes and soft-deletes. The stable key stays as a tombstone, so re-uploading the
 * same supplier sheet does not bring the product back (its rows end as Failed with a reason).
 */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/products/[id]">) {
  try {
    const { id } = await ctx.params;
    if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: "Product not found" }, { status: 404 });
    const db = getDb();
    const product = await db.query.products.findFirst({ where: eq(schema.products.id, id) });
    if (!product || product.deletedAt) return NextResponse.json({ error: "Product not found" }, { status: 404 });
    const removed = await unpublishProducts([id]);
    await db.update(schema.products).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(schema.products.id, id));
    revalidateStorefront(removed, product.category ? [product.category] : []);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return handleError(err);
  }
}

/** Merchant edit. Edited fields are remembered so a later AI rebuild never overwrites them. */
export async function PATCH(req: Request, ctx: RouteContext<"/api/products/[id]">) {
  try {
    const { id } = await ctx.params;
    const body = editSchema.parse(await req.json());
    const db = getDb();
    const product = await db.query.products.findFirst({ where: eq(schema.products.id, id) });
    if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });
    const patch = { ...body, ...(body.descriptionHtml !== undefined ? { descriptionHtml: sanitizeOutputHtml(body.descriptionHtml) } : {}) };
    const edited = new Set(product.editedFields);
    for (const k of Object.keys(patch)) edited.add(k);
    const title = patch.title ?? product.title ?? "";
    const descriptionHtml = patch.descriptionHtml ?? product.descriptionHtml ?? "";
    const englishHash = sha256(`${title}\n${descriptionHtml}`);
    await db
      .update(schema.products)
      .set({ ...patch, editedFields: [...edited], englishHash, updatedAt: new Date() })
      .where(eq(schema.products.id, id));
    // English changed → re-translate ahead of time (manual translations are kept and marked out of date).
    if (englishHash !== product.englishHash) await send(QUEUES.translate, { importId: null, productIds: [id] });
    if (product.status === "approved") {
      await refreshPublished([id]);
      revalidateStorefront([product.handle], [product.category ?? "", patch.category ?? ""].filter(Boolean));
    }
    after(() => kickWorker()); // the edit queued a re-translation
    return NextResponse.json(await productDetail(id));
  } catch (err) {
    return handleError(err);
  }
}
