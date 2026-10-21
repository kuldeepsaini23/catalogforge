import { fixEncoding } from "./encoding";
import { compactKey, normalizeWhitespace, titleCase, typoDistance } from "./text";

/** Canonical English colour → synonyms (EN variants, DE, FR). */
export const COLOURS: Record<string, string[]> = {
  black: ["schwarz", "noir", "noire", "jet black"],
  white: ["weiss", "weiß", "blanc", "blanche", "off white"],
  ivory: ["elfenbein", "ivoire"],
  cream: ["creme", "crème", "ecru", "écru"],
  grey: ["gray", "grau", "gris", "grise"],
  anthracite: ["anthrazit", "anthracite grey", "charcoal"],
  silver: ["silber", "argent"],
  red: ["rot", "rouge"],
  burgundy: ["bordeaux", "weinrot"],
  pink: ["rosa", "rose"],
  orange: ["orange"],
  terracotta: ["terrakotta", "terre cuite"],
  rust: ["rost", "rouille"],
  yellow: ["gelb", "jaune"],
  mustard: ["senf", "senfgelb", "moutarde"],
  gold: ["golden", "doré", "gülden"],
  green: ["grün", "gruen", "vert", "verte"],
  olive: ["oliv", "olivgrün", "olive green"],
  sage: ["salbei", "sauge", "sage green"],
  "forest green": ["tannengrün", "dark green", "dunkelgrün", "vert forêt"],
  mint: ["mintgrün", "menthe"],
  teal: ["petrol", "bleu canard"],
  blue: ["blau", "bleu", "bleue"],
  navy: ["marine", "navy blue", "dunkelblau", "bleu marine"],
  "sky blue": ["hellblau", "bleu ciel", "light blue"],
  purple: ["lila", "violett", "violet"],
  lavender: ["lavendel", "lavande"],
  brown: ["braun", "marron", "brun"],
  beige: ["sand", "sable"],
  taupe: ["taupe grey"],
  natural: ["natur", "naturel", "naturelle", "nature"],
  oak: ["eiche", "chêne"],
  walnut: ["nussbaum", "noyer"],
  copper: ["kupfer", "cuivre"],
  brass: ["messing", "laiton"],
  clear: ["transparent", "klar"],
  multicolour: ["multicolor", "mehrfarbig", "bunt", "multicolore"],
};

const LOOKUP = new Map<string, string>();
for (const [canonical, synonyms] of Object.entries(COLOURS)) {
  LOOKUP.set(compactKey(canonical), canonical);
  for (const s of synonyms) LOOKUP.set(compactKey(s), canonical);
}
const CANDIDATES = [...LOOKUP.keys()];
const CANONICAL_KEYS = new Set(Object.keys(COLOURS).map(compactKey));

export interface ColourResult {
  /** Display value, e.g. "Terracotta" or "Black / White". */
  value: string;
  known: boolean;
  corrections: Array<{ from: string; to: string; kind: "colour_typo" | "colour_translation" | "encoding" }>;
}

function normalizeOne(raw: string): ColourResult {
  const fixed = fixEncoding(raw);
  const corrections: ColourResult["corrections"] = [];
  if (fixed !== raw) corrections.push({ from: raw, to: fixed, kind: "encoding" });
  const key = compactKey(fixed);
  if (!key) return { value: "", known: false, corrections };

  const exact = LOOKUP.get(key);
  if (exact) {
    if (compactKey(exact) !== key) corrections.push({ from: fixed, to: exact, kind: "colour_translation" });
    return { value: titleCase(exact), known: true, corrections };
  }

  // Typo correction: closest known colour within a length-scaled edit distance.
  const maxDistance = key.length <= 4 ? 1 : key.length <= 8 ? 2 : 3;
  // Ties prefer the canonical English name; a tie between two different colours is ambiguous → no guess.
  let best: { cand: string; d: number; canonical: boolean } | null = null;
  let ambiguous = false;
  for (const cand of CANDIDATES) {
    const d = typoDistance(key, cand, maxDistance);
    if (d > maxDistance) continue;
    const canonical = CANONICAL_KEYS.has(cand);
    if (!best || d < best.d || (d === best.d && canonical && !best.canonical)) {
      ambiguous = false;
      best = { cand, d, canonical };
    } else if (d === best.d && canonical === best.canonical && LOOKUP.get(cand) !== LOOKUP.get(best.cand)) {
      ambiguous = true;
    }
  }
  if (best && !ambiguous) {
    const canonical = LOOKUP.get(best.cand)!;
    corrections.push({ from: fixed, to: canonical, kind: "colour_typo" });
    return { value: titleCase(canonical), known: true, corrections };
  }
  return { value: titleCase(normalizeWhitespace(fixed)), known: false, corrections };
}

/** Normalises a colour cell. Multi-colour values ("black/white", "rot & weiß") are split and joined. */
export function normalizeColour(raw: string | null | undefined): ColourResult | null {
  const input = normalizeWhitespace(raw ?? "");
  if (!input) return null;
  const parts = input.split(/\s*(?:\/|&|\+|,|\band\b|\bund\b|\bet\b)\s*/i).filter(Boolean);
  if (parts.length <= 1) return normalizeOne(input);
  const results = parts.map(normalizeOne);
  return {
    value: results.map((r) => r.value).join(" / "),
    known: results.every((r) => r.known),
    corrections: results.flatMap((r) => r.corrections),
  };
}

const SIZE_CANON: Record<string, string[]> = {
  XXS: ["xxs", "2xs"],
  XS: ["xs", "extra small", "x-small", "extrasmall"],
  S: ["s", "small", "klein", "petit", "petite"],
  M: ["m", "medium", "mittel", "moyen", "moyenne"],
  L: ["l", "large", "groß", "gross", "grand", "grande"],
  XL: ["xl", "extra large", "x-large", "extralarge", "sehr groß"],
  XXL: ["xxl", "2xl"],
  "One size": ["one size", "onesize", "os", "einheitsgröße", "taille unique"],
};
const SIZE_LOOKUP = new Map<string, string>();
for (const [canon, syn] of Object.entries(SIZE_CANON)) for (const s of syn) SIZE_LOOKUP.set(compactKey(s), canon);

/** Normalises sizes: letter sizes to S/M/L…, measured sizes to "30 cm" style. */
export function normalizeSize(raw: string | null | undefined): { value: string; changed: boolean } | null {
  const input = normalizeWhitespace(fixEncoding(raw ?? ""));
  if (!input) return null;
  const canon = SIZE_LOOKUP.get(compactKey(input));
  if (canon) return { value: canon, changed: canon !== input };
  const measured = /^(ø\s*)?(\d+(?:[.,]\d+)?)\s*(cm|mm|m|in|")$/i.exec(input);
  if (measured) {
    const value = `${measured[1] ? "Ø " : ""}${measured[2].replace(",", ".")} ${measured[3].toLowerCase().replace('"', "in")}`;
    return { value, changed: value !== input };
  }
  return { value: input, changed: false };
}

export function isSizeToken(token: string): boolean {
  return SIZE_LOOKUP.has(compactKey(token)) || /^\d{1,3}(cm|mm)?$/i.test(token);
}

export function isColourToken(token: string): boolean {
  return LOOKUP.has(compactKey(token));
}
