import type { Lang } from "./language";

/** Where a cleaned value came from: sheet row number (header = row 1) and original column header. */
export interface Source {
  row: number;
  column: string;
}

export interface Cell<T> {
  value: T;
  raw: string;
  source: Source;
}

export type CorrectionKind =
  | "encoding"
  | "colour_typo"
  | "colour_translation"
  | "size"
  | "unit_conversion"
  | "price_format"
  | "currency_inferred"
  | "html_sanitized"
  | "sku_normalized"
  | "duplicate_merged";

export interface Correction {
  row: number;
  column: string;
  kind: CorrectionKind;
  from: string;
  to: string;
}

export type IssueCode =
  | "missing_price"
  | "invalid_price"
  | "unknown_currency"
  | "missing_sku"
  | "missing_title"
  | "invalid_weight"
  | "implausible_weight"
  | "invalid_dimensions"
  | "unknown_colour"
  | "conflict"
  | "possible_duplicate"
  | "empty_row";

export interface Issue {
  row: number;
  column?: string;
  code: IssueCode;
  message: string;
  /** Blocking issues force needs_review regardless of model confidence. */
  blocking: boolean;
}

export interface CleanRow {
  row: number;
  /** sha256 of the row's raw cells (order-independent): stable across re-uploads and reordering. */
  rowKey: string;
  sku?: Cell<string>;
  parentSku?: Cell<string>;
  handle?: Cell<string>;
  title?: Cell<string>;
  description?: Cell<{ html: string; text: string }>;
  colour?: Cell<string>;
  size?: Cell<string>;
  material?: Cell<string>;
  price?: Cell<{ cents: number; currency: string }>;
  weightGrams?: Cell<number>;
  dimensionsCm?: Cell<{ lengthCm: number; widthCm?: number; heightCm?: number }>;
  notes?: Cell<string>;
  care?: Cell<string>;
  brand?: Cell<string>;
  category?: Cell<string>;
  origin?: Cell<string>;
  image?: Cell<string>;
  extra: Record<string, Cell<string>>;
  /** Plain-text cell contents keyed by original header — what claims are verified against. */
  texts: Record<string, string>;
  language: Lang;
  corrections: Correction[];
  issues: Issue[];
  empty: boolean;
}
