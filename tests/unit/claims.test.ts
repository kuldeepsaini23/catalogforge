import { describe, expect, it } from "vitest";
import { assembleProduct } from "@/lib/ai/assemble";
import { findTerms, findUnsupportedTerms, verifyClaims } from "@/lib/ai/claims";
import type { AiProductDraft } from "@/lib/ai/schema";
import type { ProductInput } from "@/lib/ai/types";

const input: ProductInput = {
  key: "P:tp1001",
  rows: [
    { row: 14, language: "en", cells: { "Product Name": "Classic Terracotta Pot", Notes: "Frost-resistant, not frost-proof. Hand-finished (not handmade)." } },
    { row: 15, language: "de", cells: { "Product Name": "Blumentopf", Hinweise: "Spülmaschinenfest. Nicht frostfest." } },
    { row: 212, language: "en", cells: { Care: "Suitable for occasional dishwasher use; hand washing recommended." } },
  ],
  variants: [{ sku: "TP-1001-S", options: { size: "S" }, price_cents: 1299, currency: "EUR", weight_grams: 650, rows: [14] }],
  facts: {},
  photos: [],
  issues: [],
  languages: ["en", "de"],
};

const claim = (text: string, source: string, quote: string) => ({ text, source, quote });

describe("findTerms", () => {
  it("detects negation in EN/DE/FR", () => {
    expect(findTerms("not frost-proof")).toEqual([{ term: "frost-proof", negated: true }]);
    expect(findTerms("Nicht spülmaschinenfest")).toEqual([{ term: "dishwasher-safe", negated: true }]);
    expect(findTerms("ne passe pas au four")).toEqual([]);
    expect(findTerms("Frost-resistant, not frost-proof")).toEqual(
      expect.arrayContaining([{ term: "frost-resistant", negated: false }, { term: "frost-proof", negated: true }]),
    );
  });

  // Phrasings real models cited in the first gateway run; the verifier used to drop all of them.
  it.each([
    ["Veganes Sojawachs, Baumwolldocht.", "vegan"],
    ["Bleifreie Glasur.", "lead-free"],
    ["Fair-Trade-zertifiziert.", "fair trade"],
    ["FSC-zertifizierte Eiche, mit lebensmittelechtem Öl behandelt.", "food-safe"],
    ["Machine wash 30 °C, do not tumble dry.", "machine-washable"],
    ["Handgefertigte Vase aus Portugal.", "handmade"],
    ["Bougie végane.", "vegan"],
    ["Handcrafted from natural rattan.", "handmade"],
    ["Hand-poured soy candle.", "hand-poured"],
  ])("recognises inflected and alternate wording: %s", (text, term) => {
    expect(findTerms(text)).toContainEqual({ term, negated: false });
  });

  it("still requires the whole phrase (no partial-word matches)", () => {
    expect(findTerms("Organically shaped bowl")).toEqual([]);
    expect(findTerms("biography")).toEqual([]);
  });

  it("does not let a negation leak across a clause boundary", () => {
    expect(findTerms("Not glazed. Frost-proof to -20 °C")).toEqual([{ term: "frost-proof", negated: false }]);
  });
});

describe("verifyClaims", () => {
  it("keeps a claim whose quote is in the cited cell and matches nuance", () => {
    const { kept, dropped } = verifyClaims([claim("Frost-resistant (not frost-proof)", "row 14, column Notes", "Frost-resistant, not frost-proof")], input);
    expect(dropped).toEqual([]);
    expect(kept).toHaveLength(1);
  });

  it("drops an overstated claim: frost-proof when the source says not frost-proof", () => {
    const { dropped } = verifyClaims([claim("Frost-proof", "row 14, column Notes", "Frost-resistant, not frost-proof")], input);
    expect(dropped[0].reason).toMatch(/NOT "frost-proof"/);
  });

  it("drops a stronger term than the source supports (handmade vs hand-finished)", () => {
    const { dropped } = verifyClaims([claim("Handmade", "row 14, column Notes", "Hand-finished (not handmade)")], input);
    expect(dropped).toHaveLength(1);
  });

  it("drops 'dishwasher-safe' when the cell only says occasional dishwasher use", () => {
    const { dropped } = verifyClaims([claim("Dishwasher-safe", "row 212, column Care", "Suitable for occasional dishwasher use")], input);
    expect(dropped[0].reason).toMatch(/not stated/);
  });

  it("accepts German source text for an English claim", () => {
    const { kept } = verifyClaims([claim("Dishwasher-safe", "row 15, column Hinweise", "Spülmaschinenfest")], input);
    expect(kept).toHaveLength(1);
  });

  it("drops quotes that are not in the cited cell, wrong rows and wrong columns", () => {
    const { dropped } = verifyClaims(
      [
        claim("Organic", "row 14, column Notes", "100% organic clay"),
        claim("Frost-resistant", "row 99, column Notes", "Frost-resistant"),
        claim("Frost-resistant", "row 14, column Material", "Frost-resistant"),
        claim("Frost-resistant", "Notes", "Frost-resistant"),
      ],
      input,
    );
    expect(dropped.map((d) => d.reason)).toEqual([
      expect.stringMatching(/Quote not found/),
      expect.stringMatching(/not one of this product's rows/),
      expect.stringMatching(/has no column/),
      expect.stringMatching(/Unparseable source/),
    ]);
  });

  it("is tolerant of case, whitespace and typographic quotes in the quote", () => {
    const { kept } = verifyClaims([claim("Frost-resistant", "row 14, column notes", "  frost-resistant,   NOT frost‑proof ")], input);
    expect(kept).toHaveLength(1);
  });
});

describe("findUnsupportedTerms", () => {
  it("flags claims smuggled into the description", () => {
    expect(findUnsupportedTerms(["A lovely pot. Fully frost-proof and organic."], [], input)).toEqual(["frost-proof", "organic"]);
  });
  it("allows terms backed by a verified claim or stated (un-negated) in the source", () => {
    expect(findUnsupportedTerms(["Frost-resistant pot, not frost-proof"], [], input)).toEqual([]);
  });
});

describe("assembleProduct", () => {
  const draft: AiProductDraft = {
    key: "P:tp1001",
    title: "Classic Terracotta Pot",
    description_html: '<p onclick="x()">Frost-resistant planter.</p><script>alert(1)</script>',
    category: "Planters & Pots",
    tags: ["Terracotta", "terracotta", "garden"],
    attributes: { material: "Terracotta" },
    claims: [
      claim("Frost-resistant (not frost-proof)", "row 14, column Notes", "Frost-resistant, not frost-proof"),
      claim("Handmade", "row 14, column Notes", "Hand-finished"),
    ],
    confidence: { title: 97, category: 81, "attributes.care": 64 },
    needs_review: false,
    review_reason: null,
  };

  it("produces the exact export shape, sanitised, with verified claims only", () => {
    const r = assembleProduct(input, draft, { handle: "classic-terracotta-pot", minConfidence: 70 });
    expect(Object.keys(r.product).sort()).toEqual(
      ["attributes", "category", "claims", "confidence", "description_html", "handle", "review_reason", "source_rows", "status", "tags", "title", "variants"].sort(),
    );
    expect(r.product.description_html).toBe("<p>Frost-resistant planter.</p>");
    expect(r.product.category).toBe("Home & Garden > Plants > Planters & Pots");
    expect(r.product.tags).toEqual(["terracotta", "garden"]);
    expect(r.product.claims).toEqual([{ text: "Frost-resistant (not frost-proof)", source: "row 14, column Notes" }]);
    expect(r.product.source_rows).toEqual([14, 15, 212]);
    expect(r.product.variants[0]).toEqual({ sku: "TP-1001-S", options: { size: "S" }, price_cents: 1299, currency: "EUR", weight_grams: 650 });
  });

  it("sends low confidence, dropped claims and fuzzy categories to review with reasons", () => {
    const r = assembleProduct(input, draft, { handle: "classic-terracotta-pot", minConfidence: 70 });
    expect(r.product.status).toBe("needs_review");
    expect(r.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/Removed unverified claim "Handmade"/), "Low confidence: attributes.care (64)"]));
  });

  it("rejects categories outside the taxonomy and missing prices", () => {
    const r = assembleProduct(
      { ...input, variants: [{ ...input.variants[0], price_cents: null }] },
      { ...draft, category: "Spaceships > Rockets", claims: [], confidence: { title: 99 } },
      { handle: "x", minConfidence: 70 },
    );
    expect(r.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/not in the taxonomy/), "Missing price for SKU TP-1001-S (row 14)"]));
  });

  it("marks a clean product done", () => {
    const r = assembleProduct(input, { ...draft, description_html: "<p>Terracotta planter.</p>", claims: [draft.claims[0]], confidence: { title: 95, category: 92 }, category: "Home & Garden > Plants > Planters & Pots" }, { handle: "x", minConfidence: 70 });
    expect(r.product.status).toBe("done");
    expect(r.product.review_reason).toBeNull();
  });
});
