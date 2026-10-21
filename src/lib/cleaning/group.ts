import { isColourToken, isSizeToken } from "./colour";
import { canonicalJson, compactKey, sha256, similarity, slugify, tokenize } from "./text";
import type { CleanRow, Correction, Issue } from "./types";

export interface VariantDraft {
  sku: string;
  options: Record<string, string>;
  priceCents: number | null;
  currency: string | null;
  weightGrams: number | null;
  /** All rows that describe this SKU (duplicates merged). */
  rows: number[];
}

export interface ProductGroup {
  /** Stable key: same supplier product → same key across uploads, independent of row order. */
  key: string;
  rows: CleanRow[];
  variants: VariantDraft[];
  issues: Issue[];
  corrections: Correction[];
  /** Keys of other groups that look like the same product. */
  possibleDuplicates: string[];
}

export interface GroupResult {
  groups: ProductGroup[];
  /** Rows that cannot belong to any product (empty rows). */
  orphanRows: CleanRow[];
}

class UnionFind {
  private parent = new Map<number, number>();
  find(x: number): number {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }
}

/** Strips trailing variant segments ("-RED", "-L", "_30CM", "-TER") from a SKU. */
export function baseSku(sku: string, colour?: string, size?: string): string {
  const tokens = sku.toUpperCase().split(/[-_/.\s]+/).filter(Boolean);
  const colourKey = colour ? compactKey(colour) : "";
  const sizeKey = size ? compactKey(size) : "";
  while (tokens.length > 1) {
    const t = tokens[tokens.length - 1];
    const k = compactKey(t);
    const isVariantToken =
      (isSizeToken(t) && !/^\d+$/.test(t)) ||
      isColourToken(t) ||
      (colourKey && (k === colourKey || isAbbreviation(k, colourKey))) ||
      (sizeKey && (k === sizeKey || k === sizeKey.replace(/cm$/, "")));
    if (!isVariantToken) break;
    tokens.pop();
  }
  return tokens.join("-");
}

/** "TER" → terracotta, "BLK" → black: same first letter, letters appear in order. */
function isAbbreviation(token: string, word: string): boolean {
  if (token.length < 2 || token.length > 4 || !/^[a-z]+$/.test(token) || token[0] !== word[0]) return false;
  let i = 0;
  for (const ch of word) if (ch === token[i]) i++;
  return i === token.length;
}

/** Title without the row's own option words, used for title-based grouping and duplicate detection. */
export function titleKey(row: CleanRow): string {
  if (!row.title) return "";
  const optionTokens = new Set([
    ...tokenize(row.colour?.value ?? ""),
    ...tokenize(row.colour?.raw ?? ""),
    ...tokenize(row.size?.value ?? ""),
    ...tokenize(row.size?.raw ?? ""),
  ]);
  return tokenize(row.title.value)
    .filter((t) => !optionTokens.has(t) && !/^\d+(cm|mm)?$/.test(t))
    .join(" ");
}

function primaryKey(row: CleanRow): string {
  if (row.parentSku) return `P:${compactKey(row.parentSku.value)}`;
  if (row.handle) return `H:${slugify(row.handle.value)}`;
  if (row.sku) return `P:${compactKey(baseSku(row.sku.value, row.colour?.value, row.size?.value))}`;
  return `T:${titleKey(row)}`;
}

/**
 * Groups cleaned rows into products with variants. Works on split, duplicated and out-of-order rows:
 * rows are joined when they share a parent/handle/base-SKU key or the exact same (normalised) SKU,
 * and title-only rows are attached to the single keyed group with the same title.
 */
export function groupRows(rows: CleanRow[]): GroupResult {
  const usable = rows.filter((r) => !r.empty);
  const orphanRows = rows.filter((r) => r.empty);
  const uf = new UnionFind();
  const byKey = new Map<string, number>();
  const bySku = new Map<string, number>();

  usable.forEach((row, i) => {
    const key = primaryKey(row);
    const prevKey = byKey.get(key);
    if (prevKey === undefined) byKey.set(key, i);
    else uf.union(prevKey, i);
    if (row.sku) {
      const sk = compactKey(row.sku.value);
      const prev = bySku.get(sk);
      if (prev === undefined) bySku.set(sk, i);
      else uf.union(prev, i);
    }
  });

  // Title-only rows (no SKU/parent/handle) join a keyed group with the same title, if unambiguous.
  const keyedByTitle = new Map<string, Set<number>>();
  usable.forEach((row, i) => {
    if (!primaryKey(row).startsWith("T:")) {
      const tk = titleKey(row);
      if (tk) {
        if (!keyedByTitle.has(tk)) keyedByTitle.set(tk, new Set());
        keyedByTitle.get(tk)!.add(uf.find(i));
      }
    }
  });
  usable.forEach((row, i) => {
    if (primaryKey(row).startsWith("T:")) {
      const roots = keyedByTitle.get(titleKey(row));
      if (roots && roots.size === 1) uf.union([...roots][0], i);
    }
  });

  const members = new Map<number, CleanRow[]>();
  usable.forEach((row, i) => {
    const root = uf.find(i);
    if (!members.has(root)) members.set(root, []);
    members.get(root)!.push(row);
  });

  const groups = [...members.values()].map(buildGroup);
  // Ensure keys are unique even if two unrelated groups produced the same key.
  const seen = new Map<string, number>();
  for (const g of groups) {
    const n = seen.get(g.key) ?? 0;
    seen.set(g.key, n + 1);
    if (n > 0) g.key = `${g.key}#${n}`;
  }
  detectDuplicates(groups);
  groups.sort((a, b) => a.rows[0].row - b.rows[0].row);
  return { groups, orphanRows };
}

function buildGroup(rows: CleanRow[]): ProductGroup {
  rows.sort((a, b) => a.row - b.row);
  // Group key = the most common primary key among member rows (ties → lexicographically smallest).
  const keyCounts = new Map<string, number>();
  for (const r of rows) keyCounts.set(primaryKey(r), (keyCounts.get(primaryKey(r)) ?? 0) + 1);
  const key = [...keyCounts.entries()].sort((a, b) => {
    const pa = a[0].startsWith("T:") ? 1 : 0;
    const pb = b[0].startsWith("T:") ? 1 : 0;
    return pa - pb || b[1] - a[1] || a[0].localeCompare(b[0]);
  })[0][0];

  const issues: Issue[] = rows.flatMap((r) => r.issues);
  const corrections: Correction[] = rows.flatMap((r) => r.corrections);
  const variants = new Map<string, VariantDraft>();
  const firstRowForSku = new Map<string, CleanRow>();

  for (const r of rows) {
    const sku = r.sku?.value ?? `CF-${sha256(key + r.rowKey).slice(0, 8).toUpperCase()}`;
    const sk = compactKey(sku);
    const options: Record<string, string> = {};
    if (r.colour) options.colour = r.colour.value;
    if (r.size) options.size = r.size.value;
    const existing = variants.get(sk);
    if (!existing) {
      variants.set(sk, {
        sku,
        options,
        priceCents: r.price?.value.cents ?? null,
        currency: r.price?.value.currency ?? null,
        weightGrams: r.weightGrams?.value ?? null,
        rows: [r.row],
      });
      firstRowForSku.set(sk, r);
      continue;
    }
    const first = firstRowForSku.get(sk)!;
    existing.rows.push(r.row);
    if (existing.sku !== sku) {
      corrections.push({ row: r.row, column: r.sku!.source.column, kind: "sku_normalized", from: sku, to: existing.sku });
    }
    const conflicts: string[] = [];
    const cmp = (label: string, a: unknown, b: unknown, fmt: (v: unknown) => string = String) => {
      if (a !== null && a !== undefined && b !== null && b !== undefined && a !== b) {
        conflicts.push(`${label} ${fmt(a)} (row ${first.row}) vs ${fmt(b)} (row ${r.row})`);
      }
    };
    cmp("price", existing.priceCents, r.price?.value.cents, (v) => `${v}`);
    cmp("currency", existing.currency, r.price?.value.currency);
    cmp("weight", existing.weightGrams, r.weightGrams?.value, (v) => `${v} g`);
    cmp("colour", existing.options.colour, options.colour);
    cmp("size", existing.options.size, options.size);
    // Fill gaps from the duplicate (e.g. first row had no price).
    if (existing.priceCents === null && r.price) {
      existing.priceCents = r.price.value.cents;
      existing.currency = r.price.value.currency;
    }
    if (existing.weightGrams === null && r.weightGrams) existing.weightGrams = r.weightGrams.value;
    if (conflicts.length) {
      issues.push({
        row: r.row,
        column: r.sku?.source.column,
        code: "conflict",
        message: `Conflicting rows for SKU ${existing.sku}: ${conflicts.join("; ")}`,
        blocking: true,
      });
    } else {
      corrections.push({
        row: r.row,
        column: r.sku?.source.column ?? "SKU",
        kind: "duplicate_merged",
        from: `row ${r.row}`,
        to: `duplicate of row ${first.row}`,
      });
    }
  }

  // A missing price on a row is resolved if a duplicate row for the same SKU supplied one.
  const resolvedIssues = issues.filter((i) => {
    if (i.code !== "missing_price" && i.code !== "invalid_price") return true;
    const row = rows.find((r) => r.row === i.row);
    const v = row?.sku ? variants.get(compactKey(row.sku.value)) : undefined;
    return !(v && v.priceCents !== null && i.code === "missing_price");
  });

  return {
    key,
    rows,
    variants: [...variants.values()],
    issues: resolvedIssues,
    corrections,
    possibleDuplicates: [],
  };
}

/** Flags (does not merge) groups whose titles are the same or nearly the same. */
function detectDuplicates(groups: ProductGroup[]): void {
  const titles = groups.map((g) => {
    const counts = new Map<string, number>();
    for (const r of g.rows) {
      const t = titleKey(r);
      if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  });
  // Block on the first token to avoid O(n²) comparisons across the whole sheet.
  const buckets = new Map<string, number[]>();
  titles.forEach((t, i) => {
    if (!t) return;
    const b = t.split(" ")[0];
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b)!.push(i);
  });
  for (const idxs of buckets.values()) {
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        const a = idxs[x];
        const b = idxs[y];
        const ta = titles[a];
        const tb = titles[b];
        const sim = ta === tb ? 1 : similarity(ta, tb);
        if (sim >= 0.92) {
          flag(groups[a], groups[b], ta === tb ? "same title" : `similar title (${Math.round(sim * 100)}%)`);
        }
      }
    }
  }
}

function flag(a: ProductGroup, b: ProductGroup, why: string): void {
  a.possibleDuplicates.push(b.key);
  b.possibleDuplicates.push(a.key);
  const msg = (other: ProductGroup) =>
    `Possible duplicate of product with rows ${other.rows.map((r) => r.row).slice(0, 5).join(", ")} (${why})`;
  a.issues.push({ row: a.rows[0].row, code: "possible_duplicate", message: msg(b), blocking: true });
  b.issues.push({ row: b.rows[0].row, code: "possible_duplicate", message: msg(a), blocking: true });
}

/**
 * Content hash of a product's inputs. Excludes row numbers so re-ordering a sheet does not trigger
 * a rebuild, but includes every cleaned value and matched photo.
 */
export function groupContentHash(group: ProductGroup, photoHashes: string[] = []): string {
  const rows = group.rows
    .map((r) => ({ k: r.rowKey }))
    .sort((a, b) => a.k.localeCompare(b.k));
  return sha256(canonicalJson({ rows, photos: [...photoHashes].sort(), v: 1 }));
}
