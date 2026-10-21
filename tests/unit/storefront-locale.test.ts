import { describe, expect, it } from "vitest";
import { COLOURS } from "@/lib/cleaning/colour";
import { COLOUR_NAMES, localOptionValue } from "@/lib/storefront";

describe("storefront option values", () => {
  it("shows colours in the shopper's language, combinations included", () => {
    expect(localOptionValue("de", "colour", "White")).toBe("Weiß");
    expect(localOptionValue("fr", "colour", "Black / White")).toBe("Noir / Blanc");
    expect(localOptionValue("en", "colour", "White")).toBe("White");
  });

  it("leaves sizes and unknown values alone", () => {
    expect(localOptionValue("de", "size", "15 cm")).toBe("15 cm");
    expect(localOptionValue("de", "colour", "Speckled")).toBe("Speckled");
  });

  it("has a German and French name for every colour the cleaner can produce", () => {
    expect(Object.keys(COLOURS).filter((c) => !COLOUR_NAMES[c])).toEqual([]);
  });
});
