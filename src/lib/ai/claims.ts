import { stripDiacritics } from "@/lib/cleaning/text";
import type { Claim, DroppedClaim, ProductInput } from "./types";

/**
 * Claim terms that are easy to over-state. Each term lists the phrasings (EN/DE/FR) that count as
 * support for it. "frost-resistant" deliberately does NOT support "frost-proof".
 */
export const CLAIM_TERMS: Record<string, string[]> = {
  "frost-proof": ["frost-proof", "frost proof", "frostproof", "frostfest", "frostsicher", "ingélif", "ingelif"],
  "frost-resistant": ["frost-resistant", "frost resistant", "frost-hardy", "frost hardy", "frostbeständig", "frostbestandig", "winterhart", "résistant au gel", "resistant au gel", "résiste au gel"],
  waterproof: ["waterproof", "water-proof", "wasserdicht", "imperméable", "impermeable"],
  "water-resistant": ["water-resistant", "water resistant", "wasserabweisend", "déperlant", "deperlant"],
  "dishwasher-safe": ["dishwasher-safe", "dishwasher safe", "spülmaschinenfest", "spülmaschinengeeignet", "spuelmaschinenfest", "lave-vaisselle", "lave vaisselle"],
  "microwave-safe": ["microwave-safe", "microwave safe", "mikrowellengeeignet", "mikrowellenfest", "micro-ondes", "micro ondes"],
  "oven-safe": ["oven-safe", "oven safe", "ofenfest", "backofengeeignet", "va au four", "passe au four"],
  "food-safe": ["food-safe", "food safe", "lebensmittelecht", "lebensmittelsicher", "contact alimentaire"],
  organic: ["organic", "bio", "öko", "oko", "biologique", "kbA"],
  handmade: ["handmade", "hand-made", "hand made", "handcrafted", "hand-crafted", "handgemacht", "handgefertigt", "handgearbeitet", "fait main", "fait à la main", "artisanal"],
  "hand-finished": ["hand-finished", "hand finished", "von hand veredelt", "handveredelt", "fini à la main"],
  "hand-painted": ["hand-painted", "hand painted", "handbemalt", "peint à la main"],
  recycled: ["recycled", "recycelt", "recyceltem", "recyclé"],
  vegan: ["vegan", "végan", "végane"],
  "fair trade": ["fair trade", "fair-trade", "fairtrade", "fair gehandelt", "commerce équitable"],
  "uv-resistant": ["uv-resistant", "uv resistant", "uv-beständig", "uv-bestandig", "résistant aux uv"],
  "non-toxic": ["non-toxic", "non toxic", "ungiftig", "non toxique"],
  "lead-free": ["lead-free", "lead free", "bleifrei", "sans plomb"],
  "machine-washable": ["machine-washable", "machine washable", "machine wash", "maschinenwaschbar", "maschinenwäsche", "in der maschine waschbar", "lavable en machine", "lavage en machine", "laver en machine"],
  hypoallergenic: ["hypoallergenic", "hypoallergen", "hypoallergénique"],
  "fsc-certified": ["fsc"],
};

const NEGATIONS = ["not", "no", "non", "never", "nicht", "kein", "keine", "nie", "pas", "jamais", "ne", "without", "ohne", "sans"];

export function normalizeForMatch(s: string): string {
  return stripDiacritics(s.normalize("NFKC").toLowerCase())
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const INFLECTION = "(?:e|er|es|en|em|n|s)?";

const TERM_PATTERNS = Object.fromEntries(
  Object.entries(CLAIM_TERMS).map(([term, phrasings]) => [
    term,
    // Optional ending so inflected German/French forms count ("veganes", "bleifreie",
    // "lebensmittelechtem", "véganes"); the phrase itself must still be whole.
    phrasings.map((p) => new RegExp(`(^|[^a-z0-9])${escapeRe(normalizeForMatch(p))}${INFLECTION}(?=$|[^a-z0-9])`, "g")),
  ]),
) as Record<string, RegExp[]>;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface TermHit {
  term: string;
  negated: boolean;
}

/** Finds claim terms in text, noting whether each occurrence is negated ("not frost-proof"). */
export function findTerms(text: string): TermHit[] {
  const t = normalizeForMatch(text);
  const hits: TermHit[] = [];
  for (const [term, patterns] of Object.entries(TERM_PATTERNS)) {
    for (const re of patterns) {
      re.lastIndex = 0;
      for (let m = re.exec(t); m; m = re.exec(t)) {
        const start = m.index + m[1].length;
        hits.push({ term, negated: isNegated(t, start) });
      }
    }
  }
  return hits;
}

function isNegated(text: string, start: number): boolean {
  // Look back up to 3 words, stopping at clause boundaries.
  const before = text.slice(Math.max(0, start - 40), start);
  const clause = before.split(/[.;:!?,()]|\b(?:but|aber|mais|however|jedoch)\b/).pop() ?? "";
  const words = clause.trim().split(/\s+/).slice(-3);
  return words.some((w) => NEGATIONS.includes(w.replace(/[^a-z']/g, "").replace(/^n'$/, "ne")));
}

const SOURCE_RE = /^row (\d+), column (.+)$/i;

export function parseSource(source: string): { row: number; column: string } | null {
  const m = SOURCE_RE.exec(source.trim());
  return m ? { row: Number(m[1]), column: m[2].trim() } : null;
}

/**
 * Verifies every claim against the product's source rows:
 *  1. the cited row and column exist;
 *  2. the quote appears verbatim (modulo case/whitespace/punctuation variants) in that cell;
 *  3. every strong term in the claim is supported by the quote with the same polarity — so
 *     "frost-proof" is rejected when the source says "frost-resistant, not frost-proof".
 */
export function verifyClaims(claims: Claim[], input: ProductInput): { kept: Claim[]; dropped: DroppedClaim[] } {
  const kept: Claim[] = [];
  const dropped: DroppedClaim[] = [];
  for (const claim of claims) {
    const reason = checkClaim(claim, input);
    if (reason) dropped.push({ ...claim, reason });
    else kept.push(claim);
  }
  return { kept, dropped };
}

function checkClaim(claim: Claim, input: ProductInput): string | null {
  const src = parseSource(claim.source);
  if (!src) return `Unparseable source "${claim.source}"`;
  const row = input.rows.find((r) => r.row === src.row);
  if (!row) return `Cited row ${src.row} is not one of this product's rows`;
  const columnKey = Object.keys(row.cells).find((c) => normalizeForMatch(c) === normalizeForMatch(src.column));
  if (!columnKey) return `Row ${src.row} has no column "${src.column}"`;
  const cell = normalizeForMatch(row.cells[columnKey]);
  const quote = normalizeForMatch(claim.quote).replace(/^["']|["']$/g, "");
  if (!quote || !cell.includes(quote)) return `Quote not found in row ${src.row}, column ${columnKey}`;

  const claimTerms = findTerms(claim.text);
  const quoteTerms = findTerms(quote);
  for (const ct of claimTerms) {
    const support = quoteTerms.filter((qt) => qt.term === ct.term);
    if (support.length === 0) return `"${ct.term}" is not stated in the cited source`;
    if (!support.some((qt) => qt.negated === ct.negated)) {
      return ct.negated
        ? `Source asserts "${ct.term}" but claim negates it`
        : `Source says NOT "${ct.term}" — claim overstates it`;
    }
  }
  return null;
}

/**
 * Strong terms that appear (un-negated) in generated copy must be backed by a verified claim or
 * appear un-negated in the product's own source text. Catches claims smuggled into the description.
 */
export function findUnsupportedTerms(generatedTexts: string[], kept: Claim[], input: ProductInput): string[] {
  const supported = new Set<string>();
  for (const c of kept) for (const h of findTerms(c.text)) if (!h.negated) supported.add(h.term);
  for (const r of input.rows) {
    for (const v of Object.values(r.cells)) for (const h of findTerms(v)) if (!h.negated) supported.add(h.term);
  }
  const unsupported = new Set<string>();
  for (const text of generatedTexts) {
    for (const h of findTerms(text)) if (!h.negated && !supported.has(h.term)) unsupported.add(h.term);
  }
  return [...unsupported];
}
