import { htmlToText } from "@/lib/cleaning/html";
import { COUNTRIES, languageForCountry } from "@/lib/translate/locales";

/** Lengths search engines show before truncating (Google: ~60 characters / ~155 characters). */
export const META_TITLE_MAX = 60;
export const META_DESCRIPTION_MAX = 155;

export interface SeoFields {
  metaTitle: string;
  metaDescription: string;
}

/** Cuts at the last word boundary that fits, adding "…" only when something was cut. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–-]+$/, "")}…`;
}

/**
 * Meta title and description for one language, derived from the product's reviewed (and, for
 * DE/FR, translated) copy. Built in code rather than by the model: it costs nothing and can't
 * contain a claim the claim checker didn't already approve.
 */
export function seoFields(title: string, descriptionHtml: string, brand?: string): SeoFields {
  const withBrand = brand && !title.toLowerCase().includes(brand.toLowerCase()) ? `${title} | ${brand}` : title;
  const metaTitle = withBrand.length <= META_TITLE_MAX ? withBrand : clip(title, META_TITLE_MAX);
  const text = htmlToText(descriptionHtml);
  return { metaTitle, metaDescription: clip(text || title, META_DESCRIPTION_MAX) };
}

/**
 * hreflang alternates for a storefront path ("/products/x"): one URL per language-region the
 * country switcher offers, plus x-default (US, English).
 */
export function hreflangAlternates(path: string): Record<string, string> {
  const out: Record<string, string> = { "x-default": `/store/US${path}` };
  for (const c of COUNTRIES) {
    const tag = `${languageForCountry(c.code)}-${c.code.split("-")[0]}`;
    out[tag] ??= `/store/${c.code}${path}`;
  }
  return out;
}
