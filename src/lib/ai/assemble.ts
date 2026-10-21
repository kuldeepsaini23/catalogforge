import { htmlToText, sanitizeOutputHtml } from "@/lib/cleaning/html";
import { resolveCategory } from "@/lib/taxonomy";
import { findUnsupportedTerms, verifyClaims } from "./claims";
import { catalogProductSchema, type AiProductDraft, type CatalogProduct } from "./schema";
import type { Claim, DroppedClaim, ProductInput } from "./types";

export const MAX_PLAUSIBLE_GRAMS = 100_000;

export interface AssembleResult {
  product: CatalogProduct;
  claims: Claim[];
  dropped: DroppedClaim[];
  reasons: string[];
  minConfidence: number;
}

/**
 * Combines the model's draft with the deterministic facts, then validates everything the model
 * could get wrong: claims (verified against the cited cell), copy that mentions unverified claims,
 * taxonomy membership, prices, SKUs and weights, and per-field confidence. Pure.
 */
export function assembleProduct(
  input: ProductInput,
  draft: AiProductDraft,
  opts: { handle: string; minConfidence: number },
): AssembleResult {
  const reasons: string[] = [];
  const confidence = { ...draft.confidence };

  // 1. Claims must quote their cited cell; nuance must match.
  const { kept, dropped } = verifyClaims(draft.claims, input);
  for (const d of dropped) reasons.push(`Removed unverified claim "${d.text}": ${d.reason}`);

  // 2. Copy must not contain claims that were not verified.
  const description_html = sanitizeOutputHtml(draft.description_html);
  const unsupported = findUnsupportedTerms(
    [draft.title, htmlToText(description_html), draft.tags.join(" "), Object.values(draft.attributes).join(" ")],
    kept,
    input,
  );
  for (const term of unsupported) reasons.push(`Copy says "${term}" but no source row supports it`);

  // 3. Category must exist in the taxonomy.
  const cat = resolveCategory(draft.category);
  let category = draft.category;
  if (cat.path) {
    category = cat.path;
    if (!cat.exact) confidence.category = Math.min(confidence.category ?? 100, 75);
  } else {
    reasons.push(`Category "${draft.category}" is not in the taxonomy`);
    confidence.category = Math.min(confidence.category ?? 0, 40);
  }

  // 4. Deterministic variant checks.
  const skus = new Set<string>();
  for (const v of input.variants) {
    if (skus.has(v.sku)) reasons.push(`Duplicate SKU ${v.sku}`);
    skus.add(v.sku);
    if (v.price_cents === null) reasons.push(`Missing price for SKU ${v.sku} (row ${v.rows.join(", ")})`);
    if (v.weight_grams !== null && (v.weight_grams <= 0 || v.weight_grams > MAX_PLAUSIBLE_GRAMS)) {
      reasons.push(`Implausible weight ${v.weight_grams} g for SKU ${v.sku}`);
    }
  }

  // 5. Blocking issues found while cleaning (conflicts, ambiguous prices, possible duplicates…).
  for (const issue of input.issues) {
    if (issue.blocking && !reasons.some((r) => r.includes(issue.message))) {
      if (issue.code === "missing_price") continue; // already reported per SKU above
      reasons.push(`Row ${issue.row}: ${issue.message}`);
    }
  }

  // 6. Low-confidence fields.
  const scores = Object.entries(confidence);
  for (const [field, score] of scores) {
    if (score < opts.minConfidence) reasons.push(`Low confidence: ${field} (${score})`);
  }
  if (draft.needs_review) reasons.push(`Model: ${draft.review_reason ?? "flagged for review"}`);

  const uniqueReasons = [...new Set(reasons)];
  const product = catalogProductSchema.parse({
    title: draft.title.trim(),
    handle: opts.handle,
    description_html,
    category,
    tags: [...new Set(draft.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))],
    attributes: draft.attributes,
    variants: input.variants.map((v) => ({
      sku: v.sku,
      options: v.options,
      price_cents: v.price_cents,
      currency: v.currency,
      weight_grams: v.weight_grams,
    })),
    claims: kept.map(({ text, source }) => ({ text, source })),
    confidence,
    status: uniqueReasons.length ? "needs_review" : "done",
    review_reason: uniqueReasons.length ? uniqueReasons.join("; ").slice(0, 2000) : null,
    source_rows: [...new Set(input.rows.map((r) => r.row))].sort((a, b) => a - b),
  });

  return {
    product,
    claims: kept,
    dropped,
    reasons: uniqueReasons,
    minConfidence: scores.length ? Math.min(...scores.map(([, s]) => s)) : 0,
  };
}
