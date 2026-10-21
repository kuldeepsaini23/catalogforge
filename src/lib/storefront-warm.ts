import { getDb, schema } from "@/lib/db/client";
import { getCollection, getCollections, getProduct } from "@/lib/storefront";

/**
 * Fills the storefront's in-process data cache ahead of shoppers: after publishing, and once after
 * a deploy. A first page view then only costs a render, never a database round trip, which keeps
 * the storefront fast even while an import keeps Postgres busy.
 */
export async function warmStorefront(handles?: string[], concurrency = 8): Promise<{ products: number; collections: number }> {
  const list =
    handles ??
    (await getDb().select({ handle: schema.storefrontProducts.handle }).from(schema.storefrontProducts)).map((r) => r.handle);
  const collections = await getCollections();
  for (const c of collections) await getCollection(c.slug);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, list.length) }, async () => {
      while (i < list.length) await getProduct(list[i++]);
    }),
  );
  return { products: list.length, collections: collections.length };
}
