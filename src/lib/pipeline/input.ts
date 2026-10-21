import type { ProductGroup } from "@/lib/cleaning/group";
import type { Lang } from "@/lib/cleaning/language";
import { formatDims } from "@/lib/cleaning/row";
import type { CleanRow } from "@/lib/cleaning/types";
import type { ProductInput } from "@/lib/ai/types";
import { titleKey } from "@/lib/cleaning/group";
import { titleCase } from "@/lib/cleaning/text";

export interface InputPhoto {
  id: string;
  fileName: string;
  path: string;
  mediaType: string;
}

function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | undefined;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

/** Prefers English rows for text facts, then the most frequent value. */
function pick(rows: CleanRow[], get: (r: CleanRow) => string | undefined): { value: string; language: Lang } | undefined {
  const withValue = rows.filter((r) => get(r));
  if (!withValue.length) return undefined;
  const english = withValue.filter((r) => r.language === "en");
  const pool = english.length ? english : withValue;
  const value = mostCommon(pool.map((r) => get(r)!))!;
  return { value, language: pool.find((r) => get(r) === value)!.language };
}

/** Pure: a cleaned product group (+ its matched photos) → what the model sees. */
export function toProductInput(group: ProductGroup, photos: InputPhoto[], merchantNote?: string | null): ProductInput {
  const rows = group.rows;
  const facts: Record<string, string> = {};
  const title = pick(rows, (r) => (r.title ? titleKey(r) && r.title.value : undefined));
  if (title) {
    // Strip this row's own option words from the title hint ("Terracotta Pot Red L" → "Terracotta Pot").
    const row = rows.find((r) => r.title?.value === title.value)!;
    const stripped = titleKey(row);
    facts.title = stripped ? titleCase(stripped) : title.value;
    facts.title_language = title.language;
  }
  const desc = pick(rows, (r) => r.description?.value.text);
  if (desc) {
    facts.description = desc.value.slice(0, 1_000);
    facts.description_language = desc.language;
  }
  const simple: Array<[string, (r: CleanRow) => string | undefined]> = [
    ["material", (r) => r.material?.value],
    ["brand", (r) => r.brand?.value],
    ["origin", (r) => r.origin?.value],
    ["category_hint", (r) => r.category?.value],
    ["dimensions", (r) => (r.dimensionsCm ? formatDims(r.dimensionsCm.value) : undefined)],
  ];
  for (const [name, get] of simple) {
    const v = pick(rows, get);
    if (v) facts[name] = v.value;
  }
  const care = pick(rows, (r) => r.care?.value);
  if (care) {
    facts.care = care.value;
    facts.care_language = care.language;
  }
  const colours = [...new Set(group.variants.map((v) => v.options.colour).filter(Boolean))];
  const sizes = [...new Set(group.variants.map((v) => v.options.size).filter(Boolean))];
  if (colours.length) facts.colours = colours.join(", ");
  if (sizes.length) facts.sizes = sizes.join(", ");

  return {
    key: group.key,
    rows: rows.map((r) => ({ row: r.row, language: r.language, cells: { ...r.texts } })),
    variants: group.variants.map((v) => ({
      sku: v.sku,
      options: v.options,
      price_cents: v.priceCents,
      currency: v.currency,
      weight_grams: v.weightGrams,
      rows: v.rows,
    })),
    facts,
    photos,
    issues: group.issues,
    languages: [...new Set(rows.map((r) => r.language))],
    ...(merchantNote ? { merchantNote } : {}),
  };
}
