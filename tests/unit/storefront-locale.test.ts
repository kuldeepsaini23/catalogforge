import { describe, expect, it } from "vitest";
import { COLOURS } from "@/lib/cleaning/colour";
import { COLOUR_NAMES, localOptionValue } from "@/lib/storefront";
import { sourceText, translatedAttributes, translatedTags } from "@/lib/translate/fields";

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

describe("translating tags and attribute values", () => {
  const product = { title: "Bowl", descriptionHtml: "<p>x</p>", tags: ["stoneware", "bowl\nlarge"], attributes: { material: "Stoneware", origin: "Portugal" } };

  it("sends lists as one item per line, in order", () => {
    expect(sourceText(product, "tags")).toBe("stoneware\nbowl large");
    expect(sourceText(product, "attributes")).toBe("Stoneware\nPortugal");
  });

  it("maps translated lines back to the English keys, keeping English for a missing line", () => {
    expect(translatedAttributes(product.attributes, "Steinzeug\nPortugal")).toEqual({ material: "Steinzeug", origin: "Portugal" });
    expect(translatedAttributes(product.attributes, "Steinzeug")).toEqual({ material: "Steinzeug", origin: "Portugal" });
    expect(translatedTags("Steinzeug\n\nSchale ")).toEqual(["Steinzeug", "Schale"]);
  });
});
