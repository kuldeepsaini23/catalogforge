import { normalizeColour, normalizeSize } from "./colour";
import type { HeaderMapping } from "./columns";
import { fixEncoding } from "./encoding";
import { sanitizeDescription } from "./html";
import { detectLanguage } from "./language";
import { detectCurrency, parsePrice } from "./price";
import { canonicalJson, normalizeWhitespace, sha256 } from "./text";
import type { Cell, CleanRow, Correction, Issue } from "./types";
import { parseDimensions, parseLength, parseWeight, unitFromHeader } from "./units";

export interface CleanContext {
  mapping: HeaderMapping;
  /** Most common explicit currency in the sheet; used for bare numbers like "12.5". */
  defaultCurrency: string | null;
}

export type RawRow = Record<string, string>;

const MAX_PLAUSIBLE_GRAMS = 100_000;

export function rowKeyOf(raw: RawRow): string {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const val = normalizeWhitespace(v ?? "");
    if (val) normalized[normalizeWhitespace(k)] = val;
  }
  return sha256(canonicalJson(normalized));
}

/** Infers the sheet's default currency from explicit symbols/codes in the price column. */
export function inferDefaultCurrency(rows: RawRow[], mapping: HeaderMapping): string | null {
  const counts = new Map<string, number>();
  const priceCol = mapping.fields.price;
  const currencyCol = mapping.fields.currency;
  for (const r of rows) {
    const c = (currencyCol && detectCurrency(r[currencyCol] ?? "")) || (priceCol && detectCurrency(r[priceCol] ?? ""));
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const headerCurrency = priceCol ? detectCurrency(priceCol) : null;
  if (headerCurrency) return headerCurrency;
  let best: string | null = null;
  let bestN = 0;
  for (const [c, n] of counts) if (n > bestN) [best, bestN] = [c, n];
  return best;
}

/** Pure: raw sheet row → cleaned values with provenance, corrections and issues. */
export function cleanRow(raw: RawRow, row: number, ctx: CleanContext): CleanRow {
  const { fields, extra } = ctx.mapping;
  const corrections: Correction[] = [];
  const issues: Issue[] = [];
  const texts: Record<string, string> = {};

  const read = (column: string | undefined): { column: string; raw: string; text: string } | null => {
    if (!column) return null;
    const rawValue = raw[column] ?? "";
    const text = normalizeWhitespace(fixEncoding(rawValue));
    if (text !== normalizeWhitespace(rawValue) && text) {
      corrections.push({ row, column, kind: "encoding", from: rawValue, to: text });
    }
    if (!text) return null;
    return { column, raw: rawValue, text };
  };
  const cell = <T>(c: { column: string; raw: string }, value: T): Cell<T> => ({
    value,
    raw: c.raw,
    source: { row, column: c.column },
  });
  const textCell = (field: keyof typeof fields): Cell<string> | undefined => {
    const c = read(fields[field]);
    if (!c) return undefined;
    texts[c.column] = c.text;
    return cell(c, c.text);
  };

  const out: CleanRow = {
    row,
    rowKey: rowKeyOf(raw),
    extra: {},
    texts,
    language: "unknown",
    corrections,
    issues,
    empty: false,
  };

  out.sku = textCell("sku");
  if (out.sku) out.sku.value = out.sku.value.toUpperCase().replace(/\s+/g, "");
  out.parentSku = textCell("parentSku");
  if (out.parentSku) out.parentSku.value = out.parentSku.value.toUpperCase().replace(/\s+/g, "");
  out.handle = textCell("handle");
  out.title = textCell("title");
  out.material = textCell("material");
  out.notes = textCell("notes");
  out.care = textCell("care");
  out.brand = textCell("brand");
  out.category = textCell("category");
  out.origin = textCell("origin");
  out.image = textCell("image");

  const desc = read(fields.description);
  if (desc) {
    const sanitized = sanitizeDescription(desc.text);
    if (sanitized) {
      out.description = cell(desc, { html: sanitized.html, text: sanitized.text });
      texts[desc.column] = sanitized.text;
      if (sanitized.removed.length) {
        corrections.push({ row, column: desc.column, kind: "html_sanitized", from: sanitized.removed.join(", "), to: "removed" });
      }
    }
  }

  const colour = read(fields.colour);
  if (colour) {
    const n = normalizeColour(colour.text);
    if (n?.value) {
      out.colour = cell(colour, n.value);
      texts[colour.column] = colour.text;
      for (const c of n.corrections) if (c.kind !== "encoding") corrections.push({ row, column: colour.column, ...c });
      if (!n.known) {
        issues.push({ row, column: colour.column, code: "unknown_colour", message: `Unknown colour "${colour.text}" kept as-is`, blocking: false });
      }
    }
  }

  const size = read(fields.size);
  if (size) {
    const n = normalizeSize(size.text);
    if (n) {
      out.size = cell(size, n.value);
      texts[size.column] = size.text;
      if (n.changed) corrections.push({ row, column: size.column, kind: "size", from: size.text, to: n.value });
    }
  }

  // Price: never guessed. Missing/invalid → blocking issue.
  const priceCol = fields.price ?? "Price";
  const price = read(fields.price);
  const parsed = parsePrice(price?.text ?? "");
  if (parsed.ok && price) {
    const explicitCurrency = parsed.currency ?? (fields.currency ? detectCurrency(raw[fields.currency] ?? "") : null);
    const currency = explicitCurrency ?? ctx.defaultCurrency;
    if (!currency) {
      issues.push({ row, column: priceCol, code: "unknown_currency", message: `No currency for price "${price.text}"`, blocking: true });
    } else {
      out.price = cell(price, { cents: parsed.cents, currency });
      if (!/^\d+\.\d{2}$/.test(price.text)) {
        corrections.push({ row, column: priceCol, kind: "price_format", from: price.text, to: `${parsed.cents} ${currency} minor units` });
      }
      if (!explicitCurrency) {
        corrections.push({ row, column: priceCol, kind: "currency_inferred", from: price.text, to: `${currency} (sheet default)` });
      }
      for (const note of parsed.notes) {
        // "1.299" could be 1299.00 or 1.299 — never guess silently, ask a human to confirm.
        const ambiguous = note.includes("thousands");
        issues.push({
          row,
          column: priceCol,
          code: "invalid_price",
          message: ambiguous ? `Ambiguous price ${note}; please confirm` : note,
          blocking: ambiguous,
        });
      }
    }
  } else if (!parsed.ok) {
    issues.push({
      row,
      column: priceCol,
      code: parsed.reason === "missing" ? "missing_price" : "invalid_price",
      message: parsed.reason === "missing" ? "Price is missing" : parsed.message,
      blocking: true,
    });
  }

  const weight = read(fields.weight);
  if (weight) {
    const w = parseWeight(weight.text, unitFromHeader(weight.column));
    if (w.ok) {
      out.weightGrams = cell(weight, w.value);
      if (w.converted) corrections.push({ row, column: weight.column, kind: "unit_conversion", from: weight.text, to: `${w.value} g` });
      if (w.value > MAX_PLAUSIBLE_GRAMS) {
        issues.push({ row, column: weight.column, code: "implausible_weight", message: `Weight ${w.value} g looks implausible`, blocking: true });
      }
    } else {
      issues.push({ row, column: weight.column, code: "invalid_weight", message: w.message, blocking: true });
    }
  }

  const dims = read(fields.dimensions);
  if (dims) {
    const d = parseDimensions(dims.text, unitFromHeader(dims.column));
    if (d.ok) {
      out.dimensionsCm = cell(dims, d.value);
      if (d.converted) corrections.push({ row, column: dims.column, kind: "unit_conversion", from: dims.text, to: formatDims(d.value) });
    } else {
      issues.push({ row, column: dims.column, code: "invalid_dimensions", message: d.message, blocking: false });
    }
  } else if (fields.length || fields.width || fields.height) {
    const parts = (["length", "width", "height"] as const).map((f) => {
      const c = read(fields[f]);
      if (!c) return undefined;
      const r = parseLength(c.text, unitFromHeader(c.column) ?? "cm");
      if (r.ok && r.converted) corrections.push({ row, column: c.column, kind: "unit_conversion", from: c.text, to: `${r.value} cm` });
      return r.ok ? { c, v: r.value } : undefined;
    });
    if (parts[0]) {
      out.dimensionsCm = cell(parts[0].c, { lengthCm: parts[0].v, widthCm: parts[1]?.v, heightCm: parts[2]?.v });
    }
  }

  for (const header of extra) {
    const c = read(header);
    if (c) {
      out.extra[header] = cell(c, c.text);
      texts[header] = c.text;
    }
  }

  const languageText = [out.title?.value, out.description?.value.text, out.notes?.value, out.care?.value]
    .filter(Boolean)
    .join(" ");
  out.language = detectLanguage(languageText).lang;

  out.empty = !out.sku && !out.title && !out.parentSku && !out.handle;
  if (out.empty) {
    issues.push({ row, code: "empty_row", message: "Row has no SKU, parent, handle or title", blocking: true });
  } else {
    if (!out.sku) issues.push({ row, column: fields.sku ?? "SKU", code: "missing_sku", message: "SKU is missing", blocking: true });
    if (!out.title) issues.push({ row, column: fields.title ?? "Title", code: "missing_title", message: "Title is missing", blocking: false });
  }
  return out;
}

export function formatDims(d: { lengthCm: number; widthCm?: number; heightCm?: number }): string {
  return [d.lengthCm, d.widthCm, d.heightCm].filter((v) => v !== undefined).join(" × ") + " cm";
}
