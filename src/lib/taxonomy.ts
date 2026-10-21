import { compactKey, similarity, tokenize } from "@/lib/cleaning/text";

/** The merchant's category taxonomy (Shopify-style paths). Categories must resolve to one of these. */
export const TAXONOMY = [
  "Home & Garden > Plants > Planters & Pots",
  "Home & Garden > Plants > Plant Stands",
  "Home & Garden > Plants > Watering Cans",
  "Home & Garden > Garden > Garden Tools",
  "Home & Garden > Garden > Bird Feeders",
  "Home & Garden > Garden > Outdoor Lighting",
  "Home & Garden > Decor > Vases",
  "Home & Garden > Decor > Candles & Holders",
  "Home & Garden > Decor > Picture Frames",
  "Home & Garden > Decor > Mirrors",
  "Home & Garden > Decor > Baskets & Storage",
  "Home & Garden > Decor > Wall Art",
  "Home & Garden > Decor > Clocks",
  "Home & Garden > Lighting > Table Lamps",
  "Home & Garden > Lighting > Pendant Lights",
  "Home & Garden > Textiles > Cushions & Covers",
  "Home & Garden > Textiles > Throws & Blankets",
  "Home & Garden > Textiles > Rugs",
  "Home & Garden > Textiles > Curtains",
  "Home & Garden > Textiles > Bed Linen",
  "Home & Garden > Textiles > Towels",
  "Kitchen & Dining > Tableware > Plates",
  "Kitchen & Dining > Tableware > Bowls",
  "Kitchen & Dining > Tableware > Mugs & Cups",
  "Kitchen & Dining > Tableware > Glassware",
  "Kitchen & Dining > Tableware > Cutlery",
  "Kitchen & Dining > Serveware > Serving Boards",
  "Kitchen & Dining > Serveware > Jugs & Carafes",
  "Kitchen & Dining > Cookware > Pans",
  "Kitchen & Dining > Cookware > Baking Dishes",
  "Kitchen & Dining > Kitchen Tools > Utensils",
  "Kitchen & Dining > Kitchen Tools > Storage Jars",
  "Kitchen & Dining > Table Linen > Tablecloths",
  "Kitchen & Dining > Table Linen > Napkins",
  "Furniture > Seating > Chairs",
  "Furniture > Seating > Stools",
  "Furniture > Tables > Side Tables",
  "Furniture > Shelving > Shelves",
  "Bath > Accessories > Soap Dishes",
  "Bath > Accessories > Bath Mats",
  "Stationery > Paper > Notebooks",
  "Stationery > Desk > Desk Organisers",
] as const;

export type CategoryPath = (typeof TAXONOMY)[number];

const SET = new Set<string>(TAXONOMY);
const BY_KEY = new Map(TAXONOMY.map((p) => [compactKey(p), p]));

export function isValidCategory(path: string): path is CategoryPath {
  return SET.has(path);
}

/**
 * Resolves a model-proposed category to the taxonomy. Exact (ignoring case/punctuation) is accepted
 * as-is; a near match on the full path or an unambiguous leaf match is accepted and reported.
 */
export function resolveCategory(proposed: string): { path: CategoryPath | null; exact: boolean; score: number } {
  if (isValidCategory(proposed)) return { path: proposed, exact: true, score: 100 };
  const byKey = BY_KEY.get(compactKey(proposed));
  if (byKey) return { path: byKey, exact: true, score: 100 };

  const leaf = (p: string) => p.split(">").pop()!.trim();
  const leafKey = compactKey(leaf(proposed));
  const leafHits = TAXONOMY.filter((p) => compactKey(leaf(p)) === leafKey);
  if (leafHits.length === 1) return { path: leafHits[0], exact: false, score: 90 };

  let best: { path: CategoryPath; score: number } | null = null;
  const proposedTokens = tokenize(proposed).join(" ");
  for (const p of TAXONOMY) {
    const s = similarity(tokenize(p).join(" "), proposedTokens);
    if (!best || s > best.score) best = { path: p, score: s };
  }
  if (best && best.score >= 0.85) return { path: best.path, exact: false, score: Math.round(best.score * 100) };
  return { path: null, exact: false, score: best ? Math.round(best.score * 100) : 0 };
}
