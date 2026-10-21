export const LOCALES = ["en", "de", "fr"] as const;
export type Locale = (typeof LOCALES)[number];
export const TARGET_LOCALES = ["de", "fr"] as const satisfies readonly Locale[];
export type TargetLocale = (typeof TARGET_LOCALES)[number];

/**
 * Country (optionally with a language suffix for multilingual countries) → storefront language.
 * DE, AT, CH-de → German; FR, BE-fr → French; everyone else English.
 */
const COUNTRY_LANGUAGE: Record<string, Locale> = {
  DE: "de",
  AT: "de",
  "CH-DE": "de",
  FR: "fr",
  "BE-FR": "fr",
};

export function languageForCountry(country: string | null | undefined): Locale {
  if (!country) return "en";
  return COUNTRY_LANGUAGE[country.trim().toUpperCase()] ?? "en";
}

/** Countries offered in the storefront switcher. */
export const COUNTRIES: Array<{ code: string; label: string }> = [
  { code: "US", label: "United States" },
  { code: "GB", label: "United Kingdom" },
  { code: "DE", label: "Deutschland" },
  { code: "AT", label: "Österreich" },
  { code: "CH-de", label: "Schweiz (Deutsch)" },
  { code: "CH-fr", label: "Suisse (français)" },
  { code: "FR", label: "France" },
  { code: "BE-fr", label: "Belgique (français)" },
  { code: "BE-nl", label: "België (Nederlands)" },
  { code: "NL", label: "Nederland" },
];

export const TRANSLATED_FIELDS = ["title", "descriptionHtml", "tags", "attributes"] as const;
export type TranslatedField = (typeof TRANSLATED_FIELDS)[number];
