/**
 * Accuracy evaluation of the cleaning stage against a labelled test set.
 *
 * The fixture generator knows the true value of every messy cell it writes (price before
 * formatting, grams before unit conversion, colour before typos/German/mojibake, the product each
 * row belongs to). This script generates labelled sheets, runs the real cleaner, and scores each
 * field. Output: a markdown table (stdout + load/results/eval.md).
 *
 *   bun run eval            # 10,000 rows, seeds 42 and 7
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { generate, type RowTruth } from "../fixtures/generate";
import { cleanSheet, compactKey, normalizeColour, normalizeSize } from "../src/lib/cleaning";

interface Score {
  correct: number;
  total: number;
  notes: string[];
}
const score = (): Score => ({ correct: 0, total: 0, notes: [] });
const pct = (s: Score) => (s.total ? ((s.correct / s.total) * 100).toFixed(2) : "n/a");

function evaluate(rowsN: number, seed: number) {
  const g = generate(rowsN, seed, { photos: 0 });
  const cleaned = cleanSheet(g.headers, g.rows);
  const s = {
    price: score(), missingPriceFlagged: score(), currency: score(), weight: score(), colour: score(),
    size: score(), language: score(), emptyRowsFailed: score(), groupingPurity: score(), groupingCompleteness: score(),
    duplicateDetection: score(), conflictFlagged: score(), htmlSanitised: score(),
  };

  // The stored currency is the variant's (resolved across the product's rows), so score that. A
  // currency that cannot be known must be flagged for review (counts as correct: not guessed).
  const variantCurrency = new Map<number, string | null>();
  const currencyFlagged = new Set<number>();
  for (const grp of cleaned.groups) {
    const flagged = grp.issues.some((x) => x.code === "unknown_currency" && x.blocking);
    for (const v of grp.variants) for (const n of v.rows) {
      variantCurrency.set(n, v.currency);
      if (flagged) currencyFlagged.add(n);
    }
  }

  cleaned.rows.forEach((r, i) => {
    const t: RowTruth | null = g.truth[i];
    if (!t) {
      s.emptyRowsFailed.total++;
      if (r.empty) s.emptyRowsFailed.correct++;
      return;
    }
    // Price: exact integer cents for every row that has one; missing must be flagged, never guessed.
    if (t.priceCents === null) {
      s.missingPriceFlagged.total++;
      if (!r.price && r.issues.some((x) => x.code === "missing_price" && x.blocking)) s.missingPriceFlagged.correct++;
    } else if (t.priceCents !== undefined) {
      s.price.total++;
      if (r.price?.value.cents === t.priceCents) s.price.correct++;
      else if (s.price.notes.length < 5) s.price.notes.push(`row ${r.row}: "${r.price?.raw ?? g.rows[i].Price}" → ${r.price?.value.cents ?? "none"} (truth ${t.priceCents})`);
      s.currency.total++;
      if (variantCurrency.get(r.row) === t.currency || currencyFlagged.has(r.row)) s.currency.correct++;
      else if (s.currency.notes.length < 5) s.currency.notes.push(`row ${r.row}: "${g.rows[i].Price}" → ${variantCurrency.get(r.row)} (truth ${t.currency})`);
    }
    // Weight: the supplier text itself is rounded ("0,3 kg", "1.54 lbs"), so allow ±1% or the
    // precision the text can express, whichever is larger.
    s.weight.total++;
    const decimals = /[.,](\d+)/.exec(g.rows[i].Weight)?.[1].length ?? 0;
    const unitGrams = /kg/i.test(g.rows[i].Weight) ? 1000 : /lb/i.test(g.rows[i].Weight) ? 453.6 : /oz/i.test(g.rows[i].Weight) ? 28.35 : 1;
    const tol = Math.max(2, t.grams * 0.01, (unitGrams / 10 ** decimals) / 2 + 1);
    if (r.weightGrams && Math.abs(r.weightGrams.value - t.grams) <= tol) s.weight.correct++;
    else if (s.weight.notes.length < 5) s.weight.notes.push(`row ${r.row}: "${g.rows[i].Weight}" → ${r.weightGrams?.value ?? "none"} (truth ${t.grams})`);
    // Colour after typo / translation / mojibake repair, compared with the clean English colour.
    s.colour.total++;
    const expectedColour = normalizeColour(t.colour)!.value;
    if (r.colour && compactKey(r.colour.value) === compactKey(expectedColour)) s.colour.correct++;
    else if (s.colour.notes.length < 5) s.colour.notes.push(`row ${r.row}: "${g.rows[i].Colour}" → ${r.colour?.value ?? "none"} (truth ${expectedColour})`);
    s.size.total++;
    if (r.size?.value === normalizeSize(t.size)!.value) s.size.correct++;
    // Language: the row's text language.
    s.language.total++;
    if (r.language === t.language) s.language.correct++;
    if (/<script|onclick|onmouseover|style=/i.test(g.rows[i].Description)) {
      s.htmlSanitised.total++;
      if (r.description && !/<script|onclick|onmouseover|style=/i.test(r.description.value.html)) s.htmlSanitised.correct++;
    }
  });

  // Grouping: purity (a product holds one true family) and completeness (a family lands in one product).
  const familyOfRow = new Map<number, RowTruth>();
  cleaned.rows.forEach((r, i) => g.truth[i] && familyOfRow.set(r.row, g.truth[i]!));
  const groupsOfFamily = new Map<string, Set<string>>();
  for (const grp of cleaned.groups) {
    const fams = new Set(grp.rows.map((r) => familyOfRow.get(r.row)?.family).filter(Boolean));
    s.groupingPurity.total++;
    if (fams.size === 1) s.groupingPurity.correct++;
    for (const f of fams) {
      if (!groupsOfFamily.has(f!)) groupsOfFamily.set(f!, new Set());
      groupsOfFamily.get(f!)!.add(grp.key);
    }
    // Conflicting duplicate rows must be flagged on their product.
    // Only scoreable when the conflicting row's twin survived (the generator blanks a few random rows).
    const conflictRow = grp.rows.find((r) => familyOfRow.has(r.row) && familyOfRow.get(r.row)!.priceCents === undefined);
    const twin = conflictRow && grp.rows.some((r) => r !== conflictRow && familyOfRow.get(r.row)?.sku === familyOfRow.get(conflictRow.row)!.sku && familyOfRow.get(r.row)!.priceCents !== undefined && familyOfRow.get(r.row)!.priceCents !== null);
    if (conflictRow && twin) {
      s.conflictFlagged.total++;
      if (grp.issues.some((x) => x.code === "conflict")) s.conflictFlagged.correct++;
      else if (s.conflictFlagged.notes.length < 5) s.conflictFlagged.notes.push(`${grp.key}: rows ${grp.rows.map((r) => `${r.row}:${r.sku?.value}:${r.price?.raw ?? "-"}`).join(", ")}`);
    }
    // Fuzzy duplicate products must be flagged as possible duplicates.
    const dupRow = grp.rows.find((r) => familyOfRow.get(r.row)?.fuzzyDuplicate);
    const original = dupRow && familyOfRow.get(dupRow.row)!.family.replace(/X-2(\d{3})$/, "-1$1");
    if (dupRow && [...familyOfRow.values()].some((t) => t.family === original)) {
      s.duplicateDetection.total++;
      if (grp.issues.some((x) => x.code === "possible_duplicate")) s.duplicateDetection.correct++;
      else if (s.duplicateDetection.notes.length < 5) s.duplicateDetection.notes.push(`${grp.key}: "${grp.rows[0].title?.value}"`);
    }
  }
  for (const set of groupsOfFamily.values()) {
    s.groupingCompleteness.total++;
    if (set.size === 1) s.groupingCompleteness.correct++;
  }
  return s;
}

const LABELS: Record<string, string> = {
  price: "Price → integer cents (rows with a price)",
  missingPriceFlagged: "Missing price flagged, never guessed",
  currency: "Currency",
  weight: "Weight → grams (±1%)",
  colour: "Colour (typos, German, mojibake)",
  size: "Size",
  language: "Row language (EN/DE/FR)",
  htmlSanitised: "Unsafe HTML removed",
  emptyRowsFailed: "Empty rows → Failed",
  groupingPurity: "Grouping purity (one product per group)",
  groupingCompleteness: "Grouping completeness (one group per product)",
  conflictFlagged: "Conflicting duplicate rows flagged",
  duplicateDetection: "Fuzzy duplicate products flagged",
};

const runs = [
  { rows: 10_000, seed: 42 },
  { rows: 10_000, seed: 7 },
];
const results = runs.map((r) => ({ ...r, s: evaluate(r.rows, r.seed) }));
const lines = [
  "| Field | " + results.map((r) => `seed ${r.seed} (${r.rows.toLocaleString("en")} rows)`).join(" | ") + " |",
  "|---|" + results.map(() => "---:|").join(""),
  ...Object.keys(LABELS).map((k) => `| ${LABELS[k]} | ` + results.map((r) => {
    const sc = r.s[k as keyof typeof r.s];
    return `${pct(sc)}% (${sc.correct}/${sc.total})`;
  }).join(" | ") + " |"),
];
const misses = results.flatMap((r) => Object.entries(r.s).flatMap(([k, sc]) => sc.notes.map((n) => `- ${k} (seed ${r.seed}): ${n}`)));
const md = `${lines.join("\n")}\n\n${misses.length ? `Examples of misses:\n${misses.join("\n")}\n` : "No misses.\n"}`;
mkdirSync("load/results", { recursive: true });
writeFileSync("load/results/eval.md", md);
console.log(md);
