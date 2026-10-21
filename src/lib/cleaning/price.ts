import { normalizeWhitespace } from "./text";

export type PriceResult =
  | { ok: true; cents: number; currency: string | null; notes: string[] }
  | { ok: false; reason: "missing" | "invalid"; message: string };

const SYMBOLS: Array<[RegExp, string]> = [
  [/US\$|USD|\$/i, "USD"],
  [/€|EUR|euros?/i, "EUR"],
  [/£|GBP/i, "GBP"],
  [/CHF|SFr\.?|Fr\./i, "CHF"],
  [/SEK/i, "SEK"],
  [/DKK/i, "DKK"],
  [/NOK/i, "NOK"],
  [/PLN|zł/i, "PLN"],
  [/CAD|C\$/i, "CAD"],
  [/AUD|A\$/i, "AUD"],
  [/JPY|¥/i, "JPY"],
];

/** Currencies quoted without minor units. */
const ZERO_DECIMAL = new Set(["JPY"]);

const MISSING = /^(|-|–|—|n\/?a|tbd|tba|poa|on request|auf anfrage|sur demande|null|none|\?+)$/i;

export function detectCurrency(input: string): string | null {
  // Order matters: "US$" / "C$" before "$".
  for (const [re, code] of [
    [/US\$/i, "USD"] as [RegExp, string],
    [/C\$/i, "CAD"] as [RegExp, string],
    [/A\$/i, "AUD"] as [RegExp, string],
    ...SYMBOLS,
  ]) {
    if (re.test(input)) return code;
  }
  return null;
}

/**
 * Parses a supplier price into integer minor units. Never uses floating point: the number is split
 * into integer and fraction digit strings and combined with integer arithmetic.
 *
 * "1.299,00 €" → 129900 EUR, "12.5" → 1250 (currency null), "£8" → 800 GBP,
 * "$1,299.00" → 129900 USD, "EUR 24,99" → 2499 EUR.
 */
export function parsePrice(raw: string | null | undefined): PriceResult {
  const input = normalizeWhitespace(raw ?? "");
  if (MISSING.test(input)) return { ok: false, reason: "missing", message: "Price is missing" };

  const currency = detectCurrency(input);
  const notes: string[] = [];

  // Remove currency markers and anything that isn't a digit or separator.
  let numeric = input
    .replace(/US\$|C\$|A\$|USD|EUR|euros?|GBP|CHF|SFr\.?|Fr\.|SEK|DKK|NOK|PLN|zł|CAD|AUD|JPY/gi, "")
    .replace(/[€£$¥]/g, "")
    .replace(/[\s'’]/g, "")
    .replace(/,-+$|\.-+$/, "") // "24,-" = 24.00
    .trim();

  if (/^-/.test(numeric)) return { ok: false, reason: "invalid", message: `Negative price "${input}"` };
  if (/[^\d.,]/.test(numeric) || !/\d/.test(numeric)) {
    return { ok: false, reason: "invalid", message: `Unrecognised price "${input}"` };
  }

  const lastDot = numeric.lastIndexOf(".");
  const lastComma = numeric.lastIndexOf(",");
  let intPart: string;
  let fracPart = "";

  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: the right-most one is the decimal separator.
    const decimalSep = lastDot > lastComma ? "." : ",";
    const thousandsSep = decimalSep === "." ? "," : ".";
    const [i, f = ""] = numeric.split(decimalSep);
    if (numeric.split(decimalSep).length > 2) {
      return { ok: false, reason: "invalid", message: `Ambiguous price "${input}"` };
    }
    intPart = i.split(thousandsSep).join("");
    fracPart = f;
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const parts = numeric.split(sep);
    const tail = parts[parts.length - 1];
    if (parts.length > 2 || (tail.length === 3 && parts[0].length <= 3 && parts[0] !== "0")) {
      // "1.299" / "1,299" / "1.299.000" → thousands grouping.
      if (!parts.slice(1).every((p) => p.length === 3)) {
        return { ok: false, reason: "invalid", message: `Ambiguous price "${input}"` };
      }
      intPart = parts.join("");
      if (parts.length === 2) notes.push(`"${input}" read as thousands separator`);
    } else {
      intPart = parts[0];
      fracPart = tail;
    }
  } else {
    intPart = numeric;
  }

  numeric = intPart.replace(/^0+(?=\d)/, "");
  if (!/^\d+$/.test(numeric || "0") || !/^\d*$/.test(fracPart)) {
    return { ok: false, reason: "invalid", message: `Unrecognised price "${input}"` };
  }

  const minorDigits = currency && ZERO_DECIMAL.has(currency) ? 0 : 2;
  let frac = fracPart.padEnd(minorDigits, "0");
  let roundUp = false;
  if (frac.length > minorDigits) {
    roundUp = Number(frac[minorDigits]) >= 5;
    notes.push(`"${input}" rounded to ${minorDigits} decimals`);
    frac = frac.slice(0, minorDigits);
  }

  let cents = Number(numeric || "0") * 10 ** minorDigits + Number(frac || "0");
  if (roundUp) cents += 1;
  if (!Number.isSafeInteger(cents)) return { ok: false, reason: "invalid", message: `Price out of range "${input}"` };
  if (cents === 0) return { ok: false, reason: "invalid", message: `Price is zero "${input}"` };

  return { ok: true, cents, currency, notes };
}

export function formatPrice(cents: number, currency: string, locale = "en"): string {
  const digits = ZERO_DECIMAL.has(currency) ? 0 : 2;
  // Display only: convert minor units to a decimal string without float maths.
  const negative = cents < 0;
  const abs = Math.abs(cents).toString().padStart(digits + 1, "0");
  const major = digits ? abs.slice(0, -digits) : abs;
  const minor = digits ? abs.slice(-digits) : "";
  const decimal = minor ? `${major}.${minor}` : major;
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(
    // Intl needs a number; the decimal string is exact to 2dp so this is display-safe.
    Number((negative ? "-" : "") + decimal),
  );
}
