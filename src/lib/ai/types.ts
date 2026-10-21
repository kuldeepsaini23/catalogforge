import type { Lang } from "@/lib/cleaning/language";
import type { Issue } from "@/lib/cleaning/types";

/** What the model sees for one product: cleaned facts, plus raw text cells it may cite. */
export interface ProductInput {
  key: string;
  rows: Array<{ row: number; language: Lang; cells: Record<string, string> }>;
  /** Variants are computed deterministically by the cleaner; the model never invents prices. */
  variants: Array<{
    sku: string;
    options: Record<string, string>;
    price_cents: number | null;
    currency: string | null;
    weight_grams: number | null;
    rows: number[];
  }>;
  facts: Record<string, string>;
  photos: Array<{ id: string; fileName: string; path: string; mediaType: string }>;
  issues: Issue[];
  languages: Lang[];
  merchantNote?: string;
}

export interface Claim {
  text: string;
  /** "row 14, column Notes" */
  source: string;
  /** Exact supporting text from the cited cell. */
  quote: string;
}

export interface DroppedClaim extends Claim {
  reason: string;
}

export type Route = "cheap" | "strong";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
