import { connection } from "next/server";
import { exportCsv, exportProducts, exportShopifyCsv, type ExportScope } from "@/lib/export";

const encoder = new TextEncoder();

function streamOf(gen: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await gen.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
}

async function* jsonArray(scope: ExportScope, withTranslations: boolean): AsyncGenerator<string> {
  yield "[\n";
  let first = true;
  for await (const p of exportProducts(scope, withTranslations)) {
    yield (first ? "" : ",\n") + JSON.stringify(p);
    first = false;
  }
  yield "\n]\n";
}

/** GET /api/export?format=json|csv|shopify&scope=approved|reviewed|all&translations=1 — streamed. */
export async function GET(req: Request) {
  await connection();
  const p = new URL(req.url).searchParams;
  const formatParam = p.get("format");
  const format = formatParam === "csv" || formatParam === "shopify" ? formatParam : "json";
  const scopeParam = p.get("scope");
  const scope: ExportScope = scopeParam === "approved" || scopeParam === "reviewed" ? scopeParam : "all";
  const stamp = new Date().toISOString().slice(0, 10);
  const origin = new URL(req.url).origin;
  const body =
    format === "csv" ? streamOf(exportCsv(scope)) : format === "shopify" ? streamOf(exportShopifyCsv(scope, origin)) : streamOf(jsonArray(scope, p.get("translations") === "1"));
  const ext = format === "json" ? "json" : "csv";
  return new Response(body, {
    headers: {
      "Content-Type": ext === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="catalog-${format === "shopify" ? "shopify-" : ""}${scope}-${stamp}.${ext}"`,
      "Cache-Control": "no-store",
    },
  });
}
