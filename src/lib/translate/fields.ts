import type { TranslatedField } from "./locales";

interface Source {
  title: string | null;
  descriptionHtml: string | null;
  tags: string[];
  attributes: Record<string, string>;
}

/** Fields that are lists: sent and stored as one item per line, in the English order. */
export const LIST_FIELDS: ReadonlySet<TranslatedField> = new Set(["tags", "attributes"]);

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

/** The English text that is translated (and hashed) for a field. */
export function sourceText(p: Source, field: TranslatedField): string {
  switch (field) {
    case "title":
      return p.title ?? "";
    case "descriptionHtml":
      return p.descriptionHtml ?? "";
    case "tags":
      return p.tags.map(oneLine).join("\n");
    case "attributes":
      // Values only, in key order; the keys stay English and are labelled by the storefront.
      return Object.values(p.attributes).map(oneLine).join("\n");
  }
}

export function lineCount(text: string): number {
  return text.split("\n").length;
}

export function translatedTags(text: string): string[] {
  return text.split("\n").map((t) => t.trim()).filter(Boolean);
}

/** Pairs translated values back with the English keys; a missing line keeps the English value. */
export function translatedAttributes(english: Record<string, string>, text: string): Record<string, string> {
  const lines = text.split("\n");
  return Object.fromEntries(Object.entries(english).map(([k, v], i) => [k, lines[i]?.trim() || v]));
}
