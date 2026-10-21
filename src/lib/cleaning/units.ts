import { normalizeWhitespace } from "./text";

export type UnitResult<T> =
  | { ok: true; value: T; converted: boolean; unit: string }
  | { ok: false; reason: "missing" | "invalid"; message: string };

const GRAMS_PER: Record<string, number> = {
  mg: 0.001,
  g: 1,
  gr: 1,
  gram: 1,
  grams: 1,
  gramm: 1,
  gramme: 1,
  grammes: 1,
  kg: 1000,
  kgs: 1000,
  kilo: 1000,
  kilos: 1000,
  kilogram: 1000,
  kilograms: 1000,
  kilogramm: 1000,
  lb: 453.59237,
  lbs: 453.59237,
  pound: 453.59237,
  pounds: 453.59237,
  oz: 28.349523125,
  ounce: 28.349523125,
  ounces: 28.349523125,
};

const CM_PER: Record<string, number> = {
  mm: 0.1,
  cm: 1,
  m: 100,
  meter: 100,
  metre: 100,
  in: 2.54,
  inch: 2.54,
  inches: 2.54,
  '"': 2.54,
  "″": 2.54,
  ft: 30.48,
  feet: 30.48,
  foot: 30.48,
};

const MISSING = /^(|-|–|n\/?a|tbd|null|none|\?+)$/i;

/** "1,5" → 1.5, "1.234,5" → 1234.5, "1,234.5" → 1234.5 */
export function parseDecimal(input: string): number | null {
  let s = input.replace(/\s/g, "");
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    s = lastDot > lastComma ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
  } else if (lastComma >= 0) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const QTY_UNIT = /(\d[\d.,]*)\s*([a-zA-Z"″]+\.?)?/g;

/**
 * Weight → integer grams. Supports compound values ("2 lb 4 oz") and a default unit for bare
 * numbers taken from the column header (e.g. "Weight (kg)").
 */
export function parseWeight(raw: string | null | undefined, defaultUnit?: string): UnitResult<number> {
  const input = normalizeWhitespace(raw ?? "").toLowerCase();
  if (MISSING.test(input)) return { ok: false, reason: "missing", message: "Weight is missing" };
  let total = 0;
  let matched = 0;
  let unitSeen = "";
  for (const m of input.matchAll(QTY_UNIT)) {
    const qty = parseDecimal(m[1]);
    const unit = (m[2] ?? defaultUnit ?? "").replace(/\.$/, "").toLowerCase();
    if (qty === null) continue;
    const factor = GRAMS_PER[unit];
    if (factor === undefined) {
      return {
        ok: false,
        reason: "invalid",
        message: unit ? `Unknown weight unit "${unit}" in "${raw}"` : `Weight "${raw}" has no unit`,
      };
    }
    total += qty * factor;
    matched++;
    unitSeen = unitSeen ? `${unitSeen}+${unit}` : unit;
  }
  if (matched === 0) return { ok: false, reason: "invalid", message: `Unrecognised weight "${raw}"` };
  const grams = Math.round(total);
  if (grams <= 0) return { ok: false, reason: "invalid", message: `Weight "${raw}" rounds to 0 g` };
  return { ok: true, value: grams, converted: unitSeen !== "g", unit: unitSeen };
}

/** Length → centimetres, rounded to 0.1 cm. */
export function parseLength(raw: string | null | undefined, defaultUnit?: string): UnitResult<number> {
  const input = normalizeWhitespace(raw ?? "").toLowerCase().replace(/^ø\s*/, "");
  if (MISSING.test(input)) return { ok: false, reason: "missing", message: "Length is missing" };
  const m = /^(\d[\d.,]*)\s*([a-z"″]+)?\.?$/.exec(input);
  if (!m) return { ok: false, reason: "invalid", message: `Unrecognised length "${raw}"` };
  const qty = parseDecimal(m[1]);
  const unit = m[2] ?? defaultUnit ?? "";
  const factor = CM_PER[unit];
  if (qty === null || factor === undefined) {
    return { ok: false, reason: "invalid", message: `Unknown length unit in "${raw}"` };
  }
  return { ok: true, value: roundCm(qty * factor), converted: unit !== "cm", unit };
}

export interface Dimensions {
  lengthCm: number;
  widthCm?: number;
  heightCm?: number;
}

/** "30 x 20 x 15 cm", "12x8in", "300mm × 200mm", "Ø 25 cm" → centimetres. */
export function parseDimensions(raw: string | null | undefined, defaultUnit?: string): UnitResult<Dimensions> {
  const input = normalizeWhitespace(raw ?? "").toLowerCase().replace(/^ø\s*/, "");
  if (MISSING.test(input)) return { ok: false, reason: "missing", message: "Dimensions are missing" };
  const parts = input.split(/\s*[x×*]\s*/);
  if (parts.length > 3) return { ok: false, reason: "invalid", message: `Unrecognised dimensions "${raw}"` };
  // A trailing unit applies to every part without its own ("30 x 20 x 15 cm").
  const trailing = /([a-z"″]+)\.?$/.exec(parts[parts.length - 1])?.[1];
  const values: number[] = [];
  let converted = false;
  let unitSeen = "";
  for (const part of parts) {
    const r = parseLength(part, trailing ?? defaultUnit);
    if (!r.ok) return { ok: false, reason: "invalid", message: `Unrecognised dimensions "${raw}"` };
    values.push(r.value);
    converted ||= r.converted;
    unitSeen = r.unit;
  }
  const [lengthCm, widthCm, heightCm] = values;
  return { ok: true, value: { lengthCm, widthCm, heightCm }, converted, unit: unitSeen };
}

function roundCm(cm: number): number {
  return Math.round(cm * 10) / 10;
}

/** Pulls a unit hint out of a header like "Weight (kg)" or "Gewicht in g". */
export function unitFromHeader(header: string): string | undefined {
  const m = /[([]\s*([a-zA-Z"]+)\s*[)\]]|\bin\s+([a-zA-Z]+)\s*$/.exec(header);
  const unit = (m?.[1] ?? m?.[2])?.toLowerCase();
  if (!unit) return undefined;
  return unit in GRAMS_PER || unit in CM_PER ? unit : undefined;
}
