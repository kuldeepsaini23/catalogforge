import { compactKey } from "./text";

export const FIELDS = [
  "sku", "parentSku", "handle", "title", "description", "colour", "size", "material", "price",
  "currency", "weight", "dimensions", "length", "width", "height", "notes", "care", "brand",
  "category", "origin", "image", "country",
] as const;
export type Field = (typeof FIELDS)[number];

/** Header synonyms (EN/DE/FR, common supplier spellings). Matched on compactKey. */
const SYNONYMS: Record<Field, string[]> = {
  sku: ["sku", "variant sku", "artikelnummer", "art nr", "artnr", "item no", "item number", "itemno", "ref", "référence", "reference", "product code", "code", "ean sku"],
  parentSku: ["parent", "parent sku", "parentsku", "master sku", "style", "style no", "model", "modell", "group", "family", "stammartikel"],
  handle: ["handle", "slug", "url handle"],
  title: ["title", "name", "product name", "productname", "product", "bezeichnung", "artikelname", "produktname", "nom", "nom du produit", "désignation", "designation"],
  description: ["description", "body", "body html", "bodyhtml", "beschreibung", "produktbeschreibung", "long description", "desc", "description longue"],
  colour: ["colour", "color", "farbe", "couleur", "option colour", "colour name"],
  size: ["size", "grösse", "größe", "groesse", "taille", "option size", "variant size"],
  material: ["material", "materials", "matériau", "matiere", "matière", "werkstoff"],
  price: ["price", "preis", "prix", "rrp", "retail price", "vk", "vk preis", "unit price", "price eur", "price gbp", "price usd", "selling price", "uvp"],
  currency: ["currency", "währung", "waehrung", "devise"],
  weight: ["weight", "gewicht", "poids", "net weight", "shipping weight", "weight g", "weight kg", "weight lbs", "gewicht kg", "gewicht g"],
  dimensions: ["dimensions", "dimension", "maße", "masse", "abmessungen", "size cm", "dims"],
  length: ["length", "länge", "laenge", "longueur", "depth", "tiefe", "diameter", "durchmesser"],
  width: ["width", "breite", "largeur"],
  height: ["height", "höhe", "hoehe", "hauteur"],
  notes: ["notes", "note", "comments", "comment", "remarks", "hinweise", "hinweis", "bemerkung", "bemerkungen", "remarques", "supplier notes", "features", "merkmale"],
  care: ["care", "care instructions", "pflege", "pflegehinweise", "entretien", "washing"],
  brand: ["brand", "marke", "marque", "vendor", "manufacturer", "hersteller"],
  category: ["category", "kategorie", "catégorie", "product type", "type", "warengruppe", "categorie"],
  origin: ["origin", "country of origin", "herkunft", "herkunftsland", "made in", "origine"],
  image: ["image", "images", "photo", "photos", "image file", "bild", "picture", "image src"],
  country: ["market", "target country", "markt", "pays"],
};

const LOOKUP = new Map<string, Field>();
for (const field of FIELDS) for (const s of SYNONYMS[field]) LOOKUP.set(compactKey(s), field);

export interface HeaderMapping {
  /** canonical field → original header text */
  fields: Partial<Record<Field, string>>;
  /** headers not mapped to a field: kept as extra attributes */
  extra: string[];
}

export function mapHeaders(headers: string[]): HeaderMapping {
  const fields: Partial<Record<Field, string>> = {};
  const extra: string[] = [];
  for (const header of headers) {
    const key = compactKey(header.replace(/\(.*?\)|\[.*?\]/g, ""));
    const field = LOOKUP.get(key) ?? LOOKUP.get(compactKey(header)) ?? prefixMatch(key);
    if (field && !fields[field]) fields[field] = header;
    else if (header.trim()) extra.push(header);
  }
  return { fields, extra };
}

function prefixMatch(key: string): Field | undefined {
  // "price_eur_incl_vat", "weightkg" … → longest synonym that prefixes the header.
  let best: { field: Field; len: number } | undefined;
  for (const [syn, field] of LOOKUP) {
    if (syn.length >= 4 && key.startsWith(syn) && (!best || syn.length > best.len)) best = { field, len: syn.length };
  }
  return best?.field;
}
