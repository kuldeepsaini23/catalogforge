import { describe, expect, it } from "vitest";
import { clip, hreflangAlternates, META_DESCRIPTION_MAX, META_TITLE_MAX, seoFields } from "@/lib/seo";

describe("SEO fields", () => {
  it("adds the brand to the title when it fits and isn't already there", () => {
    expect(seoFields("Terracotta Planter", "<p>x</p>", "Atelier Nord").metaTitle).toBe("Terracotta Planter | Atelier Nord");
    expect(seoFields("Atelier Nord Terracotta Planter", "<p>x</p>", "Atelier Nord").metaTitle).toBe("Atelier Nord Terracotta Planter");
  });

  it("keeps meta fields within search-result lengths, cutting at a word", () => {
    const long = "Hand-finished terracotta planter with a drainage hole, frost-resistant down to minus five degrees, in three sizes. ".repeat(3);
    const s = seoFields("A".repeat(10) + " very long product title that keeps going past sixty characters", `<p>${long}</p>`, "Brand");
    expect(s.metaTitle.length).toBeLessThanOrEqual(META_TITLE_MAX);
    expect(s.metaDescription.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
    expect(s.metaDescription.endsWith("…")).toBe(true);
    expect(clip("short text", 155)).toBe("short text");
  });

  it("uses the description's text, not its HTML", () => {
    expect(seoFields("Bowl", "<p>Glazed <strong>stoneware</strong> bowl.</p><ul><li>15 cm</li></ul>").metaDescription).toBe("Glazed stoneware bowl. 15 cm");
  });

  it("links every language version with hreflang", () => {
    const alt = hreflangAlternates("/products/bowl");
    expect(alt["x-default"]).toBe("/store/US/products/bowl");
    expect(alt["de-DE"]).toBe("/store/DE/products/bowl");
    expect(alt["de-AT"]).toBe("/store/AT/products/bowl");
    expect(alt["fr-FR"]).toBe("/store/FR/products/bowl");
  });
});
