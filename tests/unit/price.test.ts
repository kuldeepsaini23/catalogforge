import { describe, expect, it } from "vitest";
import { formatPrice, parsePrice } from "@/lib/cleaning/price";

const ok = (raw: string) => {
  const r = parsePrice(raw);
  if (!r.ok) throw new Error(`expected ok for "${raw}": ${r.message}`);
  return { cents: r.cents, currency: r.currency };
};

describe("parsePrice", () => {
  it.each([
    ["1.299,00 €", 129900, "EUR"],
    ["12.5", 1250, null],
    ["£8", 800, "GBP"],
    ["$1,299.00", 129900, "USD"],
    ["EUR 24,99", 2499, "EUR"],
    ["24,99 EUR", 2499, "EUR"],
    ["€24.99", 2499, "EUR"],
    ["24.99€", 2499, "EUR"],
    ["  19,90 € ", 1990, "EUR"],
    ["CHF 1'299.50", 129950, "CHF"],
    ["1 299,00 €", 129900, "EUR"],
    ["US$ 15", 1500, "USD"],
    ["0.99", 99, null],
    ["7", 700, null],
    ["24,-", 2400, null],
    ["1.299", 129900, null],
    ["1,299", 129900, null],
    ["12,5", 1250, null],
    ["1.234.567,89 €", 123456789, "EUR"],
    ["¥1200", 1200, "JPY"],
    ["9.999", 999900, null],
  ])("%s → %d %s", (raw, cents, currency) => {
    expect(ok(raw)).toEqual({ cents, currency });
  });

  it("rounds sub-cent prices half-up without floats", () => {
    expect(ok("1,299.995")).toEqual({ cents: 130000, currency: null });
    expect(ok("0.014 €")).toEqual({ cents: 1, currency: "EUR" });
  });

  it.each(["", "   ", "-", "n/a", "N/A", "TBD", "POA", "on request", "auf Anfrage", undefined, null])(
    "missing: %s",
    (raw) => {
      const r = parsePrice(raw as string);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("missing");
    },
  );

  it.each(["abc", "12 apples", "-5", "0,00 €", "1,2,3", "1.23.4"])("invalid: %s", (raw) => {
    const r = parsePrice(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid");
  });

  it("always returns integers", () => {
    for (const raw of ["0.1", "0.2", "1.15", "2.675", "1.005", "33.33"]) {
      const r = parsePrice(raw);
      expect(r.ok && Number.isInteger(r.cents)).toBe(true);
    }
    expect(ok("1.15").cents).toBe(115);
    expect(ok("2.675").cents).toBe(267500); // three decimals → thousands grouping, flagged in notes
  });

  it("formats minor units for display", () => {
    expect(formatPrice(129900, "EUR", "de-DE")).toMatch(/1\.299,00\s?€/);
    expect(formatPrice(800, "GBP", "en-GB")).toBe("£8.00");
  });
});
