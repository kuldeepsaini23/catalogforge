import { asc, eq, sql } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { slugify } from "@/lib/cleaning/text";
import { getDb, schema } from "@/lib/db/client";
import type { StorefrontData } from "@/lib/db/schema";
import { COLLECTIONS_TAG, collectionTag, productTag } from "@/lib/revalidate";
import type { Locale } from "@/lib/translate/locales";

/**
 * Storefront reads. Only the published snapshot table is read, results are cached per handle /
 * collection ("use cache" + tags, invalidated on publish), and nothing here can call the AI —
 * so shopper pages stay fast while a 10k-row import hammers the working tables.
 */

export interface StoreProduct {
  handle: string;
  category: string;
  data: StorefrontData;
  priceMinCents: number | null;
  currency: string | null;
}

export interface StoreCollection {
  slug: string;
  category: string;
  name: string;
  count: number;
  coverPhoto: string | null;
}

export async function getCollections(): Promise<StoreCollection[]> {
  "use cache";
  cacheLife("storefront");
  cacheTag(COLLECTIONS_TAG);
  const res = await getDb().execute<{ category: string; n: string; photo: string | null }>(sql`
    SELECT category, count(*) AS n, (array_agg(data->'photos'->>0 ORDER BY handle) FILTER (WHERE data->'photos'->>0 IS NOT NULL))[1] AS photo
    FROM storefront_products GROUP BY category ORDER BY category`);
  return res.rows.map((r) => ({
    slug: slugify(r.category),
    category: r.category,
    name: r.category.split(" > ").pop() ?? r.category,
    count: Number(r.n),
    coverPhoto: r.photo,
  }));
}

export async function getCollection(slug: string, limit = 48): Promise<{ collection: StoreCollection; products: StoreProduct[] } | null> {
  "use cache";
  cacheLife("storefront");
  const collection = (await getCollections()).find((c) => c.slug === slug);
  if (!collection) return null;
  cacheTag(collectionTag(collection.category));
  const products = await getDb()
    .select({
      handle: schema.storefrontProducts.handle,
      category: schema.storefrontProducts.category,
      data: schema.storefrontProducts.data,
      priceMinCents: schema.storefrontProducts.priceMinCents,
      currency: schema.storefrontProducts.currency,
    })
    .from(schema.storefrontProducts)
    .where(eq(schema.storefrontProducts.category, collection.category))
    .orderBy(asc(schema.storefrontProducts.handle))
    .limit(limit);
  return { collection, products: products.map((p) => ({ ...p, currency: p.currency?.trim() ?? null })) };
}

export async function getProduct(handle: string): Promise<StoreProduct | null> {
  "use cache";
  cacheLife("storefront");
  cacheTag(productTag(handle));
  const [p] = await getDb()
    .select({
      handle: schema.storefrontProducts.handle,
      category: schema.storefrontProducts.category,
      data: schema.storefrontProducts.data,
      priceMinCents: schema.storefrontProducts.priceMinCents,
      currency: schema.storefrontProducts.currency,
    })
    .from(schema.storefrontProducts)
    .where(eq(schema.storefrontProducts.handle, handle))
    .limit(1);
  return p ? { ...p, currency: p.currency?.trim() ?? null } : null;
}

export async function getFeatured(limit = 8): Promise<StoreProduct[]> {
  "use cache";
  cacheLife("storefront");
  cacheTag(COLLECTIONS_TAG);
  const rows = await getDb()
    .select({
      handle: schema.storefrontProducts.handle,
      category: schema.storefrontProducts.category,
      data: schema.storefrontProducts.data,
      priceMinCents: schema.storefrontProducts.priceMinCents,
      currency: schema.storefrontProducts.currency,
    })
    .from(schema.storefrontProducts)
    .orderBy(sql`${schema.storefrontProducts.publishedAt} DESC`)
    .limit(limit);
  return rows.map((p) => ({ ...p, currency: p.currency?.trim() ?? null }));
}

export function localized(p: StoreProduct, locale: Locale) {
  return p.data.locales[locale] ?? p.data.locales.en;
}

/** UI strings for the shop chrome. */
export const STORE_COPY: Record<Locale, Record<string, string>> = {
  en: { collections: "Shop by category", newIn: "New in", from: "From", addToCart: "Add to cart", details: "Details", variants: "Options", notFound: "This product is not available.", empty: "Nothing published here yet.", products: "products", back: "All categories", preview: "Storefront preview", sku: "SKU", weight: "Weight", unavailable: "Price on request" },
  de: { collections: "Nach Kategorie einkaufen", newIn: "Neu eingetroffen", from: "Ab", addToCart: "In den Warenkorb", details: "Details", variants: "Varianten", notFound: "Dieses Produkt ist nicht verfügbar.", empty: "Hier ist noch nichts veröffentlicht.", products: "Produkte", back: "Alle Kategorien", preview: "Shop-Vorschau", sku: "Art.-Nr.", weight: "Gewicht", unavailable: "Preis auf Anfrage" },
  fr: { collections: "Acheter par catégorie", newIn: "Nouveautés", from: "À partir de", addToCart: "Ajouter au panier", details: "Détails", variants: "Options", notFound: "Ce produit n'est pas disponible.", empty: "Rien n'est encore publié ici.", products: "produits", back: "Toutes les catégories", preview: "Aperçu de la boutique", sku: "Réf.", weight: "Poids", unavailable: "Prix sur demande" },
};

export const ATTRIBUTE_LABELS: Record<Locale, Record<string, string>> = {
  en: { material: "Material", origin: "Origin", care: "Care", dimensions: "Dimensions", brand: "Brand" },
  de: { material: "Material", origin: "Herkunft", care: "Pflege", dimensions: "Maße", brand: "Marke" },
  fr: { material: "Matière", origin: "Origine", care: "Entretien", dimensions: "Dimensions", brand: "Marque" },
};
