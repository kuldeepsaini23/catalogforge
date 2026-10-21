import { sourceText } from "@/lib/translate/fields";
import { TRANSLATED_FIELDS } from "@/lib/translate/locales";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { handleError } from "@/lib/api";
import { sanitizeOutputHtml } from "@/lib/cleaning/html";
import { sha256 } from "@/lib/cleaning/text";
import { getDb, schema } from "@/lib/db/client";
import { refreshPublished } from "@/lib/publish";
import { productDetail } from "@/lib/queries";
import { revalidateStorefront } from "@/lib/revalidate";

const bodySchema = z.object({
  locale: z.enum(["de", "fr"]),
  field: z.enum(TRANSLATED_FIELDS),
  text: z.string().trim().min(1).max(10_000),
});

/** A merchant's manual translation always wins; it is tied to the English it was written against. */
export async function PUT(req: Request, ctx: RouteContext<"/api/products/[id]/translations">) {
  try {
    const { id } = await ctx.params;
    const body = bodySchema.parse(await req.json());
    const db = getDb();
    const product = await db.query.products.findFirst({ where: eq(schema.products.id, id) });
    if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });
    const english = sourceText(product, body.field);
    const text = body.field === "descriptionHtml" ? sanitizeOutputHtml(body.text) : body.text;
    const sourceHash = sha256(english);
    await db
      .insert(schema.translations)
      .values({ productId: id, locale: body.locale, field: body.field, text, status: "manual", sourceHash })
      .onConflictDoUpdate({
        target: [schema.translations.productId, schema.translations.locale, schema.translations.field],
        set: { text, status: "manual", sourceHash, error: null, updatedAt: new Date() },
      });
    if (product.status === "approved") {
      await refreshPublished([id]);
      revalidateStorefront([product.handle], []);
    }
    return NextResponse.json(await productDetail(id));
  } catch (err) {
    return handleError(err);
  }
}
