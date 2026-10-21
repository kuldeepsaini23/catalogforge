import { connection, NextResponse } from "next/server";
import { handleError } from "@/lib/api";
import { reconcile } from "@/lib/pipeline/finalize";
import { importDetail, rowStrip } from "@/lib/queries";

export async function GET(_req: Request, ctx: RouteContext<"/api/imports/[id]">) {
  await connection();
  try {
    const { id } = await ctx.params;
    const imp = await importDetail(id);
    if (!imp) return NextResponse.json({ error: "Import not found" }, { status: 404 });
    const [strip, reconciliation] = await Promise.all([rowStrip(id), reconcile(id)]);
    return NextResponse.json({ import: imp, strip, reconciliation });
  } catch (err) {
    return handleError(err);
  }
}
