import { NextResponse } from "next/server";
import { handleError } from "@/lib/api";
import { requeueProducts } from "@/lib/pipeline/build";
import { failedProductIds } from "@/lib/queries";

/** Retries every failed product of an import. */
export async function POST(_req: Request, ctx: RouteContext<"/api/imports/[id]/retry">) {
  try {
    const { id } = await ctx.params;
    const ids = await failedProductIds(id);
    const n = ids.length ? await requeueProducts(ids) : 0;
    return NextResponse.json({ retried: n });
  } catch (err) {
    return handleError(err);
  }
}
