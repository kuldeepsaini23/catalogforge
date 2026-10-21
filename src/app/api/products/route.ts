import { connection, NextResponse } from "next/server";
import { handleError, intParam } from "@/lib/api";
import { listProducts, PAGE_SIZES, type ProductSort } from "@/lib/queries";

const SORTS = new Set(["title", "status", "confidence", "updated", "cost", "speed", "category"]);
const STATUSES = new Set(["pending", "done", "needs_review", "failed", "approved"]);

export async function GET(req: Request) {
  await connection();
  try {
    const p = new URL(req.url).searchParams;
    const sort = p.get("sort");
    const status = p.get("status");
    const confidence = p.get("confidence");
    const result = await listProducts({
      q: p.get("q")?.trim() || undefined,
      status: status && STATUSES.has(status) ? status : undefined,
      category: p.get("category") || undefined,
      confidence: confidence === "low" || confidence === "mid" || confidence === "high" ? confidence : undefined,
      importId: p.get("import") || undefined,
      outOfDate: p.get("outOfDate") === "1",
      sort: sort && SORTS.has(sort) ? (sort as ProductSort) : "updated",
      dir: p.get("dir") === "asc" ? "asc" : "desc",
      page: intParam(p.get("page"), 1),
      size: intParam(p.get("size"), 25, PAGE_SIZES),
    });
    return NextResponse.json(result);
  } catch (err) {
    return handleError(err);
  }
}
