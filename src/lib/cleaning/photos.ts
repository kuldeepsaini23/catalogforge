import type { ProductGroup } from "./group";
import { compactKey, slugify, typoDistance } from "./text";

export interface PhotoMatch {
  fileName: string;
  groupKey: string | null;
  /** SKU the photo was matched to, if variant-specific. */
  sku: string | null;
  method: "sku" | "base_sku" | "handle" | "title" | "image_column" | "fuzzy" | "none";
  score: number;
}

export const PHOTO_EXTENSIONS = /\.(jpe?g|png|webp|gif|avif)$/i;

/** "TP-1001-RED_2 (1).JPG" → "tp1001red" */
export function photoStem(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const noExt = base.replace(/\.[a-z0-9]+$/i, "");
  const cleaned = noExt
    .replace(/\s*\(\d+\)$/, "")
    .replace(/[-_ ](copy|kopie)$/i, "")
    .replace(/[-_ ](front|back|side|detail|main|alt|lifestyle|\d{1,2})$/i, "")
    .replace(/[-_ ](front|back|side|detail|main|alt|lifestyle|\d{1,2})$/i, "");
  return compactKey(cleaned);
}

interface Candidate {
  key: string;
  groupKey: string;
  sku: string | null;
  method: PhotoMatch["method"];
}

/**
 * Matches photo file names to products: exact SKU / base SKU / handle / title slug first, then the
 * supplier's image column, then a bounded fuzzy match (edit distance ≤ 15% of the key length).
 */
export function matchPhotos(fileNames: string[], groups: ProductGroup[]): PhotoMatch[] {
  const exact = new Map<string, Candidate>();
  const add = (c: Candidate) => {
    if (c.key.length >= 3 && !exact.has(c.key)) exact.set(c.key, c);
  };
  const imageColumn = new Map<string, Candidate>();
  for (const g of groups) {
    for (const v of g.variants) add({ key: compactKey(v.sku), groupKey: g.key, sku: v.sku, method: "sku" });
    add({ key: compactKey(g.key.replace(/^[A-Z]:/, "").replace(/#\d+$/, "")), groupKey: g.key, sku: null, method: "base_sku" });
    for (const r of g.rows) {
      if (r.handle) add({ key: compactKey(r.handle.value), groupKey: g.key, sku: null, method: "handle" });
      if (r.title) add({ key: compactKey(slugify(r.title.value)), groupKey: g.key, sku: null, method: "title" });
      if (r.image) {
        for (const name of r.image.value.split(/[,;|\s]+/).filter(Boolean)) {
          imageColumn.set(photoStem(name), { key: photoStem(name), groupKey: g.key, sku: r.sku?.value ?? null, method: "image_column" });
        }
      }
    }
  }
  const all = [...exact.values()];

  return fileNames.map((fileName): PhotoMatch => {
    const stem = photoStem(fileName);
    const hit = imageColumn.get(stem) ?? exact.get(stem);
    if (hit) return { fileName, groupKey: hit.groupKey, sku: hit.sku, method: hit.method, score: 100 };

    // Prefix: "tp1001redlarge" → "tp1001red" (longest known key the stem starts with).
    let prefix: Candidate | undefined;
    for (let len = stem.length - 1; len >= 4 && !prefix; len--) prefix = exact.get(stem.slice(0, len));
    if (prefix) return { fileName, groupKey: prefix.groupKey, sku: prefix.sku, method: prefix.method, score: 90 };

    // Fuzzy only tolerates typos in letters/separators: digits identify products, so they must match.
    const maxD = Math.max(1, Math.floor(stem.length * 0.15));
    const digits = stem.replace(/\D/g, "");
    let best: { c: Candidate; d: number } | undefined;
    for (const c of all) {
      if (Math.abs(c.key.length - stem.length) > maxD || c.key.replace(/\D/g, "") !== digits) continue;
      const d = typoDistance(stem, c.key, maxD);
      if (d <= maxD && (!best || d < best.d)) best = { c, d };
    }
    if (best) {
      const score = Math.round((1 - best.d / stem.length) * 100);
      return { fileName, groupKey: best.c.groupKey, sku: best.c.sku, method: "fuzzy", score };
    }
    return { fileName, groupKey: null, sku: null, method: "none", score: 0 };
  });
}
