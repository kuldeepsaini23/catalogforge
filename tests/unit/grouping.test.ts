import { describe, expect, it } from "vitest";
import { baseSku, cleanSheet, groupContentHash, matchPhotos, mapHeaders, photoStem } from "@/lib/cleaning";

const HEADERS = ["Artikelnummer", "Parent", "Product Name", "Farbe", "Size", "Price", "Weight", "Notes"];
const row = (sku: string, parent: string, name: string, colour: string, size: string, price: string, weight = "500 g", notes = "") => ({
  Artikelnummer: sku,
  Parent: parent,
  "Product Name": name,
  Farbe: colour,
  Size: size,
  Price: price,
  Weight: weight,
  Notes: notes,
});

describe("mapHeaders", () => {
  it("maps EN/DE/FR synonyms and keeps unknown columns as extras", () => {
    const m = mapHeaders(["Artikelnummer", "Bezeichnung", "Couleur", "Preis (EUR)", "Gewicht (kg)", "Glaze Type"]);
    expect(m.fields).toMatchObject({
      sku: "Artikelnummer",
      title: "Bezeichnung",
      colour: "Couleur",
      price: "Preis (EUR)",
      weight: "Gewicht (kg)",
    });
    expect(m.extra).toEqual(["Glaze Type"]);
  });
});

describe("baseSku", () => {
  it.each([
    ["TP-1001-RED-L", "Red", "L", "TP-1001"],
    ["TP-1001-TER-30", "Terracotta", "30 cm", "TP-1001"],
    ["MUG_220_BLACK", "Black", undefined, "MUG-220"],
    ["MUG-220-BLK", "Black", undefined, "MUG-220"],
    ["CUSH-77", undefined, undefined, "CUSH-77"],
  ])("%s → %s", (sku, colour, size, base) => {
    expect(baseSku(sku, colour, size)).toBe(base);
  });
});

describe("cleanSheet grouping", () => {
  it("groups split, out-of-order variants and merges exact duplicates", () => {
    const { groups, rows } = cleanSheet(HEADERS, [
      row("TP-1001-RED-L", "", "Terracotta Pot Red L", "red", "L", "24,99 €"),
      row("MUG-1", "", "Stoneware Mug", "black", "", "€12.00"),
      row("TP-1001-TER-M", "TP-1001", "Terracotta Pot", "terracota", "M", "19,99 €"),
      row("TP-1001-RED-L", "", "Terracotta Pot Red L", "red", "L", "24,99 €"), // exact duplicate
      row("TP-1001-TER-L", "TP-1001", "Terracotta Pot", "Terrakotta", "L", "24,99 €"),
    ]);
    expect(rows.map((r) => r.row)).toEqual([2, 3, 4, 5, 6]);
    expect(groups).toHaveLength(2);
    const pot = groups.find((g) => g.key === "P:tp1001")!;
    expect(pot.rows.map((r) => r.row)).toEqual([2, 4, 5, 6]);
    expect(pot.variants.map((v) => v.sku).sort()).toEqual(["TP-1001-RED-L", "TP-1001-TER-L", "TP-1001-TER-M"]);
    const red = pot.variants.find((v) => v.sku === "TP-1001-RED-L")!;
    expect(red.rows).toEqual([2, 5]);
    expect(red.priceCents).toBe(2499);
    expect(pot.corrections.some((c) => c.kind === "duplicate_merged" && c.to === "duplicate of row 2")).toBe(true);
    expect(pot.corrections.some((c) => c.kind === "colour_typo" && c.from === "terracota")).toBe(true);
    expect(pot.issues.filter((i) => i.blocking)).toEqual([]);
  });

  it("flags conflicting duplicate rows as blocking", () => {
    const { groups } = cleanSheet(HEADERS, [
      row("VASE-9", "", "Glass Vase", "clear", "", "€30.00"),
      row("VASE-9", "", "Glass Vase", "clear", "", "€32.00"),
    ]);
    expect(groups).toHaveLength(1);
    const conflict = groups[0].issues.find((i) => i.code === "conflict")!;
    expect(conflict.blocking).toBe(true);
    expect(conflict.message).toContain("price 3000 (row 2) vs 3200 (row 3)");
  });

  it("treats SKUs differing only in punctuation as the same variant", () => {
    const { groups } = cleanSheet(HEADERS, [
      row("TP1001-RED-L", "", "Terracotta Pot", "red", "L", "€24.99"),
      row("TP-1001-RED-L", "", "Terracotta Pot", "red", "L", "€24.99"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].variants).toHaveLength(1);
    expect(groups[0].corrections.some((c) => c.kind === "sku_normalized")).toBe(true);
  });

  it("never guesses a missing price and keeps it blocking", () => {
    const { groups } = cleanSheet(HEADERS, [row("BOWL-1", "", "Salad Bowl", "white", "", "")]);
    expect(groups[0].variants[0].priceCents).toBeNull();
    expect(groups[0].issues).toContainEqual(expect.objectContaining({ code: "missing_price", blocking: true, row: 2 }));
  });

  it("fills a missing price from a duplicate row of the same SKU", () => {
    const { groups } = cleanSheet(HEADERS, [
      row("BOWL-1", "", "Salad Bowl", "white", "", ""),
      row("BOWL-1", "", "Salad Bowl", "white", "", "€15.00"),
    ]);
    expect(groups[0].variants[0].priceCents).toBe(1500);
    expect(groups[0].issues.some((i) => i.code === "missing_price")).toBe(false);
  });

  it("flags near-identical products with different SKUs as possible duplicates", () => {
    const { groups } = cleanSheet(HEADERS, [
      row("LIN-100", "", "Linen Cushion Cover Natural", "natural", "", "€20.00"),
      row("LX-555", "", "Linen Cushion Cover Natural", "natural", "", "€20.00"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.issues.some((i) => i.code === "possible_duplicate"))).toBe(true);
  });

  it("sends empty rows to orphans instead of inventing products", () => {
    const { groups, orphanRows } = cleanSheet(HEADERS, [row("", "", "", "", "", "€1.00")]);
    expect(groups).toHaveLength(0);
    expect(orphanRows[0].issues[0].code).toBe("empty_row");
  });

  it("keeps provenance for every cleaned value", () => {
    const { rows } = cleanSheet(HEADERS, [row("A-1", "", "Ãœber Pot", "rot", "S", "EUR 9,50", "1 lb", "Frost-resistant")]);
    const r = rows[0];
    expect(r.title).toMatchObject({ value: "Über Pot", source: { row: 2, column: "Product Name" } });
    expect(r.price).toMatchObject({ value: { cents: 950, currency: "EUR" }, source: { row: 2, column: "Price" } });
    expect(r.weightGrams).toMatchObject({ value: 454, source: { row: 2, column: "Weight" } });
    expect(r.texts.Notes).toBe("Frost-resistant");
    expect(r.corrections.map((c) => c.kind)).toEqual(expect.arrayContaining(["encoding", "colour_translation", "unit_conversion", "price_format"]));
  });

  it("content hash ignores row order but changes when a value changes", () => {
    const a = cleanSheet(HEADERS, [row("A-1", "A", "Pot", "red", "S", "€1.00"), row("A-2", "A", "Pot", "red", "M", "€2.00")]);
    const b = cleanSheet(HEADERS, [row("A-2", "A", "Pot", "red", "M", "€2.00"), row("A-1", "A", "Pot", "red", "S", "€1.00")]);
    const c = cleanSheet(HEADERS, [row("A-1", "A", "Pot", "red", "S", "€1.50"), row("A-2", "A", "Pot", "red", "M", "€2.00")]);
    expect(groupContentHash(a.groups[0])).toBe(groupContentHash(b.groups[0]));
    expect(groupContentHash(a.groups[0])).not.toBe(groupContentHash(c.groups[0]));
  });
});

describe("matchPhotos", () => {
  const { groups } = cleanSheet(HEADERS, [
    row("TP-1001-RED-L", "TP-1001", "Terracotta Pot", "red", "L", "€24.99"),
    row("MUG-220-BLK", "", "Stoneware Mug", "black", "", "€12.00"),
  ]);

  it("normalises file names", () => {
    expect(photoStem("TP-1001-RED-L_2 (1).JPG")).toBe("tp1001redl");
    expect(photoStem("photos/mug-220-blk-front.png")).toBe("mug220blk");
  });

  it("matches by SKU, base SKU, title slug and fuzzily", () => {
    const m = matchPhotos(
      ["TP-1001-RED-L.jpg", "tp-1001_3.jpg", "stoneware-mug.png", "TP-1001-RDE-L.jpg", "Stonware-Mug.png", "TP-1002-RED-L.jpg", "random-cat.jpg"],
      groups,
    );
    expect(m.map((x) => [x.groupKey, x.method])).toEqual([
      ["P:tp1001", "sku"],
      ["P:tp1001", "base_sku"],
      ["P:mug220", "title"],
      ["P:tp1001", "base_sku"], // typo in the variant part still matches the product by prefix
      ["P:mug220", "fuzzy"],
      [null, "none"], // different digits = different product, never fuzzy-matched
      [null, "none"],
    ]);
  });
});
