/**
 * Post-translation guards. A translation is accepted only if it preserves, exactly:
 * HTML tag sequence, {{placeholders}}, numbers (+ units) and brand names / kept terms.
 */

const TAG_RE = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi;
const PLACEHOLDER_RE = /\{\{\s*[^}]+?\s*\}\}/g;
// Numbers incl. decimals and an optional unit right after them.
const NUMBER_RE = /\d+(?:[.,]\d+)*(?:\s?(?:cm|mm|m|km|kg|g|mg|ml|cl|l|oz|lb|lbs|in|ft|%|°c|°f|w|v))?(?![a-z])/gi;

export function tagSequence(html: string): string[] {
  return [...html.matchAll(TAG_RE)].map((m) => `${m[0].startsWith("</") ? "/" : ""}${m[1].toLowerCase()}`);
}

export function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[0]).sort();
}

/** Numbers normalised so "1.5 l" and "1,5 l" (locale decimal comma) compare equal. */
export function numbers(text: string): string[] {
  const withoutTags = text.replace(TAG_RE, " ").replace(PLACEHOLDER_RE, " ");
  return [...withoutTags.matchAll(NUMBER_RE)]
    .map((m) => m[0].toLowerCase().replace(/\s+/g, "").replace(",", "."))
    .sort();
}

export function verifyTranslation(source: string, translated: string, keep: string[]): string[] {
  const problems: string[] = [];
  if (!translated.trim()) return ["empty translation"];
  const st = tagSequence(source);
  const tt = tagSequence(translated);
  if (st.join(",") !== tt.join(",")) problems.push(`HTML tags changed (expected ${st.join(" ") || "none"}, got ${tt.join(" ") || "none"})`);
  const sp = placeholders(source);
  const tp = placeholders(translated);
  if (sp.join("|") !== tp.join("|")) problems.push(`placeholders changed (expected ${sp.join(", ") || "none"})`);
  const sn = numbers(source);
  const tn = numbers(translated);
  if (sn.join("|") !== tn.join("|")) problems.push(`numbers/units changed (expected ${sn.join(", ") || "none"}, got ${tn.join(", ") || "none"})`);
  for (const term of keep) {
    if (!term) continue;
    const count = (s: string) => s.split(term).length - 1;
    if (count(source) > 0 && count(translated) < count(source)) problems.push(`"${term}" must stay unchanged`);
  }
  if (/<script|on[a-z]+\s*=|javascript:/i.test(translated)) problems.push("unsafe markup in translation");
  return problems;
}
