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

export const OPTION_LABELS: Record<Locale, Record<string, string>> = {
  en: { colour: "Colour", size: "Size", material: "Material" },
  de: { colour: "Farbe", size: "Größe", material: "Material" },
  fr: { colour: "Couleur", size: "Taille", material: "Matière" },
};

/** Taxonomy leaf names for the shop chrome (DE/FR); unknown leaves fall back to English. */
const CATEGORY_NAMES: Record<"de" | "fr", Record<string, string>> = {
  de: {
    "Planters & Pots": "Pflanzgefäße & Töpfe", "Plant Stands": "Pflanzenständer", "Watering Cans": "Gießkannen", "Garden Tools": "Gartenwerkzeug",
    "Bird Feeders": "Vogelfutterhäuser", "Outdoor Lighting": "Außenbeleuchtung", Vases: "Vasen", "Candles & Holders": "Kerzen & Halter",
    "Picture Frames": "Bilderrahmen", Mirrors: "Spiegel", "Baskets & Storage": "Körbe & Aufbewahrung", "Wall Art": "Wandbilder", Clocks: "Uhren",
    "Table Lamps": "Tischleuchten", "Pendant Lights": "Pendelleuchten", "Cushions & Covers": "Kissen & Bezüge", "Throws & Blankets": "Plaids & Decken",
    Rugs: "Teppiche", Curtains: "Vorhänge", "Bed Linen": "Bettwäsche", Towels: "Handtücher", Plates: "Teller", Bowls: "Schalen",
    "Mugs & Cups": "Becher & Tassen", Glassware: "Gläser", Cutlery: "Besteck", "Serving Boards": "Servierbretter", "Jugs & Carafes": "Krüge & Karaffen",
    Pans: "Pfannen", "Baking Dishes": "Auflaufformen", Utensils: "Küchenhelfer", "Storage Jars": "Vorratsgläser", Tablecloths: "Tischdecken",
    Napkins: "Servietten", Chairs: "Stühle", Stools: "Hocker", "Side Tables": "Beistelltische", Shelves: "Regale", "Soap Dishes": "Seifenschalen",
    "Bath Mats": "Badematten", Notebooks: "Notizbücher", "Desk Organisers": "Schreibtisch-Organizer",
  },
  fr: {
    "Planters & Pots": "Jardinières & pots", "Plant Stands": "Porte-plantes", "Watering Cans": "Arrosoirs", "Garden Tools": "Outils de jardin",
    "Bird Feeders": "Mangeoires", "Outdoor Lighting": "Éclairage extérieur", Vases: "Vases", "Candles & Holders": "Bougies & bougeoirs",
    "Picture Frames": "Cadres", Mirrors: "Miroirs", "Baskets & Storage": "Paniers & rangement", "Wall Art": "Décoration murale", Clocks: "Horloges",
    "Table Lamps": "Lampes à poser", "Pendant Lights": "Suspensions", "Cushions & Covers": "Coussins & housses", "Throws & Blankets": "Plaids & couvertures",
    Rugs: "Tapis", Curtains: "Rideaux", "Bed Linen": "Linge de lit", Towels: "Serviettes", Plates: "Assiettes", Bowls: "Bols",
    "Mugs & Cups": "Mugs & tasses", Glassware: "Verrerie", Cutlery: "Couverts", "Serving Boards": "Planches de service", "Jugs & Carafes": "Pichets & carafes",
    Pans: "Poêles", "Baking Dishes": "Plats à four", Utensils: "Ustensiles", "Storage Jars": "Bocaux", Tablecloths: "Nappes",
    Napkins: "Serviettes de table", Chairs: "Chaises", Stools: "Tabourets", "Side Tables": "Tables d'appoint", Shelves: "Étagères", "Soap Dishes": "Porte-savons",
    "Bath Mats": "Tapis de bain", Notebooks: "Carnets", "Desk Organisers": "Organiseurs de bureau",
  },
};

export function categoryName(category: string, locale: Locale): string {
  const leaf = category.split(" > ").pop() ?? category;
  return locale === "en" ? leaf : (CATEGORY_NAMES[locale][leaf] ?? leaf);
}
