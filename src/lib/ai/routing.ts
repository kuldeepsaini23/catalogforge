import type { ProductInput, Route } from "./types";

export interface RouteDecision {
  route: Route;
  /** Send photos with the request (strong model only). */
  vision: boolean;
  reasons: string[];
}

const LONG_FREE_TEXT = 600;

/**
 * Cheap model for clean products; strong (vision) model only when the input is messy enough that
 * the cheap model is likely to mis-read it, or when photos are needed to fill gaps.
 */
export function routeProduct(input: ProductInput): RouteDecision {
  const reasons: string[] = [];
  const nonEnglish = input.languages.some((l) => l === "de" || l === "fr");
  const mixedLanguages = new Set(input.languages.filter((l) => l !== "unknown")).size > 1;
  const conflicts = input.issues.some((i) => i.code === "conflict");
  const textLength = input.rows.reduce(
    (n, r) => n + Object.values(r.cells).reduce((m, v) => m + v.length, 0),
    0,
  );
  const hasDescription = input.rows.some((r) => Object.keys(r.cells).some((k) => /desc|beschreib|body/i.test(k)));
  const thinText = textLength < 80;

  if (mixedLanguages) reasons.push("mixed languages");
  if (conflicts) reasons.push("conflicting rows");
  if (textLength > LONG_FREE_TEXT * Math.max(1, input.rows.length)) reasons.push("long free text");
  const needsPhotos = input.photos.length > 0 && (!hasDescription || thinText);
  if (needsPhotos) reasons.push("description missing — use photos");

  // German/French alone is fine for the cheap model; it only escalates combined with other mess.
  if (nonEnglish && reasons.length === 0) return { route: "cheap", vision: false, reasons: ["non-English, otherwise clean"] };
  if (reasons.length === 0) return { route: "cheap", vision: false, reasons: ["clean"] };
  return { route: "strong", vision: needsPhotos, reasons };
}
