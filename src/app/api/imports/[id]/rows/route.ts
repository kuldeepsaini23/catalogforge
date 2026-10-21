import { connection, NextResponse } from "next/server";
import { handleError, intParam } from "@/lib/api";
import { listRows } from "@/lib/queries";

const STATUSES = new Set(["pending", "done", "needs_review", "failed"]);

export async function GET(req: Request, ctx: RouteContext<"/api/imports/[id]/rows">) {
  await connection();
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const status = url.searchParams.get("status") ?? undefined;
    const result = await listRows(id, {
      status: status && STATUSES.has(status) ? status : undefined,
      page: intParam(url.searchParams.get("page"), 1),
      size: intParam(url.searchParams.get("size"), 25, [10, 25, 50, 100]),
    });
    return NextResponse.json(result);
  } catch (err) {
    return handleError(err);
  }
}
