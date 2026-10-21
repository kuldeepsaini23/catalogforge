import { describe, expect, it } from "vitest";
import { normalizeColour, normalizeSize } from "@/lib/cleaning/colour";
import { htmlToText, sanitizeDescription } from "@/lib/cleaning/html";
import { detectLanguage } from "@/lib/cleaning/language";

describe("normalizeColour", () => {
  it("corrects typos against the known list and records the correction", () => {
    const r = normalizeColour("terracota")!;
    expect(r.value).toBe("Terracotta");
    expect(r.known).toBe(true);
    expect(r.corrections).toEqual([{ from: "terracota", to: "terracotta", kind: "colour_typo" }]);
  });

  it.each([
    ["Anthrazit", "Anthracite", "colour_translation"],
    ["schwarz", "Black", "colour_translation"],
    ["bleu marine", "Navy", "colour_translation"],
    ["Gray", "Grey", "colour_translation"],
    ["blakc", "Black", "colour_typo"],
    ["oliev", "Olive", "colour_typo"],
  ])("%s → %s (%s)", (raw, value, kind) => {
    const r = normalizeColour(raw)!;
    expect(r.value).toBe(value);
    expect(r.corrections.map((c) => c.kind)).toContain(kind);
  });

  it("keeps exact matches without corrections", () => {
    expect(normalizeColour("Sage")).toEqual({ value: "Sage", known: true, corrections: [] });
  });

  it("splits multi-colour values", () => {
    expect(normalizeColour("black/white")!.value).toBe("Black / White");
    expect(normalizeColour("rot und weiß")!.value).toBe("Red / White");
  });

  it("fixes mojibake before matching", () => {
    expect(normalizeColour("GrÃ¼n")!.value).toBe("Green");
  });

  it("keeps unknown colours, flagged as unknown, never forced to a wrong match", () => {
    const r = normalizeColour("Flamingo Sunset")!;
    expect(r.known).toBe(false);
    expect(r.value).toBe("Flamingo Sunset");
  });

  it("returns null for empty input", () => {
    expect(normalizeColour("  ")).toBeNull();
  });
});

describe("normalizeSize", () => {
  it.each([
    ["Small", "S"],
    ["groß", "L"],
    ["x-large", "XL"],
    ["30cm", "30 cm"],
    ["Ø25 cm", "Ø 25 cm"],
    ["12,5 cm", "12.5 cm"],
    ["Taille unique", "One size"],
  ])("%s → %s", (raw, value) => {
    expect(normalizeSize(raw)!.value).toBe(value);
  });
});

describe("sanitizeDescription", () => {
  it("strips scripts, event handlers and styles but keeps safe tags", () => {
    const raw =
      '<p style="color:red" onclick="steal()">Hand-thrown <b>terracotta</b></p><script>alert(1)</script><ul><li onmouseover="x()">Frost-resistant</li></ul><iframe src="//evil"></iframe>';
    const r = sanitizeDescription(raw)!;
    expect(r.html).toBe("<p>Hand-thrown <strong>terracotta</strong></p><ul><li>Frost-resistant</li></ul>");
    expect(r.html).not.toMatch(/script|onclick|style|iframe|alert/);
    expect(r.removed).toEqual(expect.arrayContaining(["script", "event handler", "style", "embed"]));
    expect(r.text).toBe("Hand-thrown terracotta Frost-resistant");
  });

  it("drops javascript: links entirely", () => {
    const r = sanitizeDescription('<a href="javascript:alert(1)">click</a> safe')!;
    expect(r.html).not.toMatch(/javascript|href/);
  });

  it("wraps plain text in paragraphs and escapes it", () => {
    const r = sanitizeDescription("Line one\n\nA < B")!;
    expect(r.html).toBe("<p>Line one</p><p>A &lt; B</p>");
  });

  it("converts html to readable text", () => {
    expect(htmlToText("<p>Hello&nbsp;world</p><p>Second</p>")).toBe("Hello world Second");
  });
});

describe("detectLanguage", () => {
  it.each([
    ["Handgefertigter Blumentopf aus Terrakotta, frostbeständig und für den Außenbereich geeignet.", "de"],
    ["Hand-thrown terracotta planter, suitable for outdoor use and made from natural clay.", "en"],
    ["Pot de fleurs en terre cuite fait main, convient pour l'extérieur.", "fr"],
    ["Nicht spülmaschinengeeignet. Nur Handwäsche.", "de"],
  ])("%s → %s", (text, lang) => {
    expect(detectLanguage(text).lang).toBe(lang);
  });

  it("returns unknown for very short or ambiguous text", () => {
    expect(detectLanguage("TP-1001").lang).toBe("unknown");
    expect(detectLanguage("").lang).toBe("unknown");
  });
});
