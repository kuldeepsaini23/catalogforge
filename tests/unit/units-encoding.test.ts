import { describe, expect, it } from "vitest";
import { fixEncoding, looksLikeMojibake } from "@/lib/cleaning/encoding";
import { parseDimensions, parseLength, parseWeight, unitFromHeader } from "@/lib/cleaning/units";

describe("parseWeight → grams", () => {
  it.each([
    ["500 g", 500],
    ["500g", 500],
    ["1.2 kg", 1200],
    ["1,2 kg", 1200],
    ["2 lbs", 907],
    ["2 lb 4 oz", 1021],
    ["8 oz", 227],
    ["0.5kg", 500],
    ["1 kilo", 1000],
    ["350 Gramm", 350],
    ["12 ounces", 340],
  ])("%s → %d g", (raw, grams) => {
    const r = parseWeight(raw);
    expect(r.ok && r.value).toBe(grams);
  });

  it("uses the header unit for bare numbers", () => {
    const r = parseWeight("2,5", unitFromHeader("Weight (kg)"));
    expect(r.ok && r.value).toBe(2500);
  });

  it("refuses bare numbers without any unit", () => {
    expect(parseWeight("500").ok).toBe(false);
  });

  it("reports missing and unknown units", () => {
    const missing = parseWeight("");
    expect(!missing.ok && missing.reason).toBe("missing");
    const unknown = parseWeight("3 stone");
    expect(!unknown.ok && unknown.reason).toBe("invalid");
  });

  it("returns integer grams", () => {
    const r = parseWeight("1.1111 lb");
    expect(r.ok && Number.isInteger(r.value)).toBe(true);
  });
});

describe("lengths and dimensions → cm", () => {
  it.each([
    ["30 cm", 30],
    ["300mm", 30],
    ["1.2 m", 120],
    ["12 in", 30.5],
    ['10"', 25.4],
    ["Ø 25 cm", 25],
    ["2 ft", 61],
  ])("%s → %d cm", (raw, cm) => {
    const r = parseLength(raw);
    expect(r.ok && r.value).toBe(cm);
  });

  it("parses L x W x H with a trailing unit", () => {
    const r = parseDimensions("30 x 20 x 15 cm");
    expect(r.ok && r.value).toEqual({ lengthCm: 30, widthCm: 20, heightCm: 15 });
  });

  it("parses inches and mixed separators", () => {
    const r = parseDimensions("12x8in");
    expect(r.ok && r.value).toEqual({ lengthCm: 30.5, widthCm: 20.3, heightCm: undefined });
    const mm = parseDimensions("300mm × 200mm");
    expect(mm.ok && mm.value).toEqual({ lengthCm: 30, widthCm: 20, heightCm: undefined });
  });

  it("reads unit hints from headers", () => {
    expect(unitFromHeader("Weight (kg)")).toBe("kg");
    expect(unitFromHeader("Gewicht in g")).toBe("g");
    expect(unitFromHeader("Höhe [mm]")).toBe("mm");
    expect(unitFromHeader("Weight")).toBeUndefined();
  });
});

describe("fixEncoding (mojibake)", () => {
  it.each([
    ["GrÃ¼n", "Grün"],
    ["WeiÃŸ", "Weiß"],
    ["FrostbestÃ¤ndig", "Frostbeständig"],
    ["CrÃ¨me brÃ»lÃ©e", "Crème brûlée"],
    ["Preis: 12 â‚¬", "Preis: 12 €"],
    ["Itâ€™s handmade", "It’s handmade"],
    ["â€œQuoteâ€\u009d", "“Quote”"],
    ["Ã˜ 25 cm", "Ø 25 cm"],
  ])("%s → %s", (raw, fixed) => {
    expect(fixEncoding(raw)).toBe(fixed);
  });

  it("repairs double-encoded text", () => {
    const once = Buffer.from("Grün", "utf8").toString("latin1");
    const twice = Buffer.from(once, "utf8").toString("latin1");
    expect(fixEncoding(twice)).toBe("Grün");
  });

  it("leaves correct text untouched", () => {
    for (const s of ["Grün", "Crème", "Ølstykke", "naïve café", "Größe XL", "plain ascii", "Äpfel über Öfen"]) {
      expect(fixEncoding(s)).toBe(s);
      expect(looksLikeMojibake(s)).toBe(false);
    }
  });
});
