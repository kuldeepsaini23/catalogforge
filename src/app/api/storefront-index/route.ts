import { connection, NextResponse } from "next/server";
import { getDb, schema } from "@/lib/db/client";
import { getCollections } from "@/lib/storefront";

/** Published handles + collection slugs (used by the k6 load test to pick pages). */
export async function GET() {
  await connection();
  const handles = await getDb().select({ handle: schema.storefrontProducts.handle }).from(schema.storefrontProducts).limit(2000);
  const collections = await getCollections();
  return NextResponse.json({ handles: handles.map((h) => h.handle), collections: collections.map((c) => c.slug) });
}
