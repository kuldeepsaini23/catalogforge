import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { rowCounts } from "@/lib/pipeline/rows";

export const PAGE_SIZES = [10, 25, 50, 100] as const;

export async function listImports(limit = 30) {
  const db = getDb();
  const imports = await db.select().from(schema.imports).orderBy(desc(schema.imports.createdAt)).limit(limit);
  if (!imports.length) return [];
  const ids = imports.map((i) => i.id);
  const counts = await db.execute<{ import_id: string; status: string; n: string }>(sql`
    SELECT import_id, status, count(*) AS n FROM source_rows WHERE import_id = ANY(${sql.param(ids)}::uuid[]) GROUP BY import_id, status`);
  const costs = await db.execute<{ import_id: string; cost: string; calls: string }>(sql`
    SELECT import_id, sum(cost_nanos) AS cost, count(*) AS calls FROM ai_calls WHERE import_id = ANY(${sql.param(ids)}::uuid[]) GROUP BY import_id`);
  return imports.map((imp) => {
    const c = { pending: 0, done: 0, needs_review: 0, failed: 0 } as Record<string, number>;
    for (const r of counts.rows) if (r.import_id === imp.id) c[r.status] = Number(r.n);
    const cost = costs.rows.find((r) => r.import_id === imp.id);
    return {
      ...imp,
      counts: { pending: c.pending, done: c.done, needsReview: c.needs_review, failed: c.failed },
      costNanos: Number(cost?.cost ?? 0),
      aiCalls: Number(cost?.calls ?? 0),
    };
  });
}
export type ImportSummary = Awaited<ReturnType<typeof listImports>>[number];

/** Row statuses in sheet order, packed as one char each (p/d/r/f) for the status strip. */
export async function rowStrip(importId: string): Promise<string> {
  const res = await getDb().execute<{ s: string }>(sql`
    SELECT string_agg(CASE status WHEN 'pending' THEN 'p' WHEN 'done' THEN 'd' WHEN 'needs_review' THEN 'r' ELSE 'f' END, '' ORDER BY row_number) AS s
    FROM source_rows WHERE import_id = ${importId}`);
  return res.rows[0]?.s ?? "";
}

export async function listRows(importId: string, opts: { status?: string; page: number; size: number }) {
  const db = getDb();
  const where = and(
    eq(schema.sourceRows.importId, importId),
    opts.status ? eq(schema.sourceRows.status, opts.status as "pending") : undefined,
  );
  const [items, [{ n }]] = await Promise.all([
    db
      .select({
        rowNumber: schema.sourceRows.rowNumber,
        status: schema.sourceRows.status,
        statusReason: schema.sourceRows.statusReason,
        language: schema.sourceRows.language,
        productId: schema.sourceRows.productId,
        sku: sql<string | null>`${schema.sourceRows.cleaned}->'sku'->>'value'`,
        title: sql<string | null>`${schema.sourceRows.cleaned}->'title'->>'value'`,
        handle: schema.products.handle,
      })
      .from(schema.sourceRows)
      .leftJoin(schema.products, eq(schema.products.id, schema.sourceRows.productId))
      .where(where)
      .orderBy(asc(schema.sourceRows.rowNumber))
      .limit(opts.size)
      .offset((opts.page - 1) * opts.size),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.sourceRows).where(where),
  ]);
  return { items, total: n };
}

const SORTS = {
  title: schema.products.title,
  status: schema.products.status,
  confidence: schema.products.minConfidence,
  updated: schema.products.updatedAt,
  cost: schema.products.aiCostNanos,
  speed: schema.products.processingMs,
  category: schema.products.category,
} as const;
export type ProductSort = keyof typeof SORTS;

export interface ProductFilters {
  q?: string;
  status?: string;
  category?: string;
  confidence?: "low" | "mid" | "high";
  importId?: string;
  outOfDate?: boolean;
  sort?: ProductSort;
  dir?: "asc" | "desc";
  page: number;
  size: number;
}

export async function listProducts(f: ProductFilters) {
  const db = getDb();
  const conds: SQL[] = [];
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, "\\$&")}%`;
    conds.push(
      or(
        ilike(schema.products.title, like),
        ilike(schema.products.handle, like),
        sql`EXISTS (SELECT 1 FROM variants v WHERE v.product_id = ${schema.products.id} AND v.sku ILIKE ${like})`,
      )!,
    );
  }
  if (f.status) conds.push(eq(schema.products.status, f.status as "done"));
  if (f.category) conds.push(eq(schema.products.category, f.category));
  if (f.importId) conds.push(eq(schema.products.lastImportId, f.importId));
  if (f.confidence === "low") conds.push(sql`${schema.products.minConfidence} < 70`);
  if (f.confidence === "mid") conds.push(sql`${schema.products.minConfidence} BETWEEN 70 AND 89`);
  if (f.confidence === "high") conds.push(sql`${schema.products.minConfidence} >= 90`);
  if (f.outOfDate) conds.push(sql`EXISTS (SELECT 1 FROM translations t WHERE t.product_id = ${schema.products.id} AND t.status = 'out_of_date')`);
  const where = conds.length ? and(...conds) : undefined;
  const col = SORTS[f.sort ?? "updated"];
  const order = f.dir === "asc" ? sql`${col} ASC NULLS LAST` : sql`${col} DESC NULLS LAST`;

  const [items, [{ n }]] = await Promise.all([
    db
      .select({
        id: schema.products.id,
        handle: schema.products.handle,
        title: schema.products.title,
        status: schema.products.status,
        category: schema.products.category,
        minConfidence: schema.products.minConfidence,
        reviewReason: schema.products.reviewReason,
        model: schema.products.model,
        route: schema.products.route,
        aiCostNanos: schema.products.aiCostNanos,
        processingMs: schema.products.processingMs,
        updatedAt: schema.products.updatedAt,
        variantCount: sql<number>`(SELECT count(*)::int FROM variants v WHERE v.product_id = ${schema.products.id})`,
        priceMin: sql<number | null>`(SELECT min(price_cents) FROM variants v WHERE v.product_id = ${schema.products.id})`,
        currency: sql<string | null>`(SELECT max(currency) FROM variants v WHERE v.product_id = ${schema.products.id})`,
        photoId: sql<string | null>`(SELECT p.id::text FROM photos p WHERE p.product_id = ${schema.products.id} ORDER BY p.match_score DESC LIMIT 1)`,
      })
      .from(schema.products)
      .where(where)
      .orderBy(order, asc(schema.products.id))
      .limit(f.size)
      .offset((f.page - 1) * f.size),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.products).where(where),
  ]);
  return { items, total: n };
}
export type ProductListItem = Awaited<ReturnType<typeof listProducts>>["items"][number];

export async function productDetail(id: string) {
  const db = getDb();
  const product = await db.query.products.findFirst({ where: eq(schema.products.id, id) });
  if (!product) return null;
  const [variants, photos, translations, rows] = await Promise.all([
    db.select().from(schema.variants).where(eq(schema.variants.productId, id)).orderBy(asc(schema.variants.position)),
    db.select({ id: schema.photos.id, fileName: schema.photos.fileName, matchMethod: schema.photos.matchMethod, matchScore: schema.photos.matchScore, sku: schema.photos.sku }).from(schema.photos).where(eq(schema.photos.productId, id)),
    db.select().from(schema.translations).where(eq(schema.translations.productId, id)),
    product.lastImportId
      ? db
          .select({ rowNumber: schema.sourceRows.rowNumber, raw: schema.sourceRows.raw, language: schema.sourceRows.language, status: schema.sourceRows.status })
          .from(schema.sourceRows)
          .where(and(eq(schema.sourceRows.productId, id), eq(schema.sourceRows.importId, product.lastImportId)))
          .orderBy(asc(schema.sourceRows.rowNumber))
      : Promise.resolve([]),
  ]);
  const published = await db.select({ handle: schema.storefrontProducts.handle, publishedAt: schema.storefrontProducts.publishedAt }).from(schema.storefrontProducts).where(eq(schema.storefrontProducts.productId, id));
  return { product, variants, photos, translations, rows, published: published[0] ?? null };
}
export type ProductDetail = NonNullable<Awaited<ReturnType<typeof productDetail>>>;

export async function categories(): Promise<string[]> {
  const res = await getDb().execute<{ category: string }>(sql`SELECT DISTINCT category FROM products WHERE category IS NOT NULL ORDER BY category`);
  return res.rows.map((r) => r.category);
}

export async function importDetail(id: string) {
  const db = getDb();
  const imp = await db.query.imports.findFirst({ where: eq(schema.imports.id, id) });
  if (!imp) return null;
  const counts = await rowCounts(db, id);
  return { ...imp, counts };
}

export async function failedProductIds(importId: string): Promise<string[]> {
  const res = await getDb()
    .selectDistinct({ id: schema.sourceRows.productId })
    .from(schema.sourceRows)
    .innerJoin(schema.products, eq(schema.products.id, schema.sourceRows.productId))
    .where(and(eq(schema.sourceRows.importId, importId), eq(schema.sourceRows.status, "failed"), inArray(schema.products.status, ["failed"])));
  return res.map((r) => r.id!).filter(Boolean);
}
