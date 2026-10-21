import { inArray } from "drizzle-orm";
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { handleError } from "@/lib/api";
import { getDb, schema } from "@/lib/db/client";
import { requeueProducts } from "@/lib/pipeline/build";
import { approveProducts, unpublishProducts } from "@/lib/publish";
import { revalidateStorefront } from "@/lib/revalidate";
import { warmStorefront } from "@/lib/storefront-warm";

const ids = z.array(z.uuid()).min(1).max(1000);
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), ids }),
  z.object({ action: z.literal("send_back"), ids, note: z.string().trim().min(3).max(1000) }),
  z.object({ action: z.literal("retry"), ids }),
]);

/** Approve (publish), send back to the AI with a note, or retry. Works for one or many products. */
export async function POST(req: Request) {
  try {
    const body = bodySchema.parse(await req.json());
    if (body.action === "approve") {
      const r = await approveProducts(body.ids);
      revalidateStorefront(r.handles, r.categories);
      // Refill the cache for what was just published, after the response is sent.
      after(() => warmStorefront(r.handles).catch((err) => console.error("storefront warm failed", err)));
      return NextResponse.json({ approved: r.published.length, skipped: r.skipped });
    }
    const rows = await getDb()
      .select({ category: schema.products.category })
      .from(schema.products)
      .where(inArray(schema.products.id, body.ids));
    const removed = await unpublishProducts(body.ids);
    revalidateStorefront(removed, rows.map((r) => r.category ?? "").filter(Boolean));
    const n = await requeueProducts(body.ids, body.action === "send_back" ? body.note : undefined);
    return NextResponse.json({ requeued: n });
  } catch (err) {
    return handleError(err);
  }
}
