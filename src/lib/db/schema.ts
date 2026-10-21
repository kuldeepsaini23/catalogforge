import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { CleanRow, Correction, Issue } from "@/lib/cleaning/types";
import type { Claim, DroppedClaim, ProductInput } from "@/lib/ai/types";

export const importStatus = pgEnum("import_status", ["queued", "parsing", "building", "paused", "completed", "failed"]);
export const rowStatus = pgEnum("row_status", ["pending", "done", "needs_review", "failed"]);
export const productStatus = pgEnum("product_status", ["pending", "done", "needs_review", "failed", "approved"]);
export const translationStatus = pgEnum("translation_status", ["machine", "manual", "out_of_date", "failed"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const imports = pgTable(
  "imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileName: text("file_name").notNull(),
    fileHash: text("file_hash").notNull(),
    sheetPath: text("sheet_path").notNull(),
    photoPaths: jsonb("photo_paths").$type<string[]>().notNull().default([]),
    status: importStatus("status").notNull().default("queued"),
    phase: text("phase"),
    totalRows: integer("total_rows"),
    productsTotal: integer("products_total"),
    photoCount: integer("photo_count").notNull().default(0),
    mode: text("mode").$type<"sync" | "batch">(),
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    pauseReason: text("pause_reason"),
    error: text("error"),
    stats: jsonb("stats").$type<ImportStats>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check("imports_total_rows_limit", sql`${t.totalRows} IS NULL OR (${t.totalRows} >= 0 AND ${t.totalRows} <= 10000)`),
    index("imports_created_idx").on(t.createdAt),
    index("imports_hash_idx").on(t.fileHash),
  ],
);

export interface ImportStats {
  corrections: Record<string, number>;
  languages: Record<string, number>;
  photosMatched: number;
  photosUnmatched: number;
  groups: number;
  skippedUnchanged: number;
  orphanRows: number;
  routing?: { cheap: number; strong: number; vision: number };
}

export const sourceRows = pgTable(
  "source_rows",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    importId: uuid("import_id").notNull().references(() => imports.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    rowKey: text("row_key").notNull(),
    raw: jsonb("raw").$type<Record<string, string>>().notNull(),
    cleaned: jsonb("cleaned").$type<CleanRow>().notNull(),
    language: text("language").notNull(),
    status: rowStatus("status").notNull().default("pending"),
    statusReason: text("status_reason"),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("source_rows_import_row_uq").on(t.importId, t.rowNumber),
    index("source_rows_import_status_idx").on(t.importId, t.status),
    index("source_rows_product_idx").on(t.productId),
    check(
      "source_rows_reason_required",
      sql`${t.status} NOT IN ('needs_review', 'failed') OR ${t.statusReason} IS NOT NULL`,
    ),
  ],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stableKey: text("stable_key").notNull(),
    handle: text("handle").notNull(),
    status: productStatus("status").notNull().default("pending"),
    reviewReason: text("review_reason"),
    title: text("title"),
    descriptionHtml: text("description_html"),
    category: text("category"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    attributes: jsonb("attributes").$type<Record<string, string>>().notNull().default({}),
    claims: jsonb("claims").$type<Claim[]>().notNull().default([]),
    droppedClaims: jsonb("dropped_claims").$type<DroppedClaim[]>().notNull().default([]),
    confidence: jsonb("confidence").$type<Record<string, number>>().notNull().default({}),
    sourceRows: integer("source_rows").array().notNull().default(sql`'{}'::integer[]`),
    issues: jsonb("issues").$type<Issue[]>().notNull().default([]),
    corrections: jsonb("corrections").$type<Correction[]>().notNull().default([]),
    input: jsonb("input").$type<ProductInput>(),
    contentHash: text("content_hash").notNull(),
    builtHash: text("built_hash"),
    lastImportId: uuid("last_import_id").references(() => imports.id, { onDelete: "set null" }),
    route: text("route").$type<"cheap" | "strong">(),
    model: text("model"),
    editedFields: text("edited_fields").array().notNull().default(sql`'{}'::text[]`),
    merchantNote: text("merchant_note"),
    aiCostNanos: bigint("ai_cost_nanos", { mode: "number" }).notNull().default(0),
    aiInputTokens: integer("ai_input_tokens").notNull().default(0),
    aiOutputTokens: integer("ai_output_tokens").notNull().default(0),
    processingMs: integer("processing_ms"),
    minConfidence: integer("min_confidence"),
    buildAttempts: integer("build_attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Soft delete: the stable key stays as a tombstone so a re-upload does not resurrect it. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    builtAt: timestamp("built_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    englishHash: text("english_hash"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("products_stable_key_uq").on(t.stableKey),
    uniqueIndex("products_handle_uq").on(t.handle),
    index("products_status_idx").on(t.status),
    index("products_last_import_idx").on(t.lastImportId),
    index("products_updated_idx").on(t.updatedAt),
    index("products_title_trgm_idx").using("gin", sql`${t.title} gin_trgm_ops`),
  ],
);

export const variants = pgTable(
  "variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    options: jsonb("options").$type<Record<string, string>>().notNull().default({}),
    priceCents: integer("price_cents"),
    currency: char("currency", { length: 3 }),
    weightGrams: integer("weight_grams"),
    sourceRows: integer("source_rows").array().notNull().default(sql`'{}'::integer[]`),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("variants_sku_uq").on(t.sku),
    index("variants_product_idx").on(t.productId),
    check("variants_price_positive", sql`${t.priceCents} IS NULL OR ${t.priceCents} > 0`),
    check("variants_weight_positive", sql`${t.weightGrams} IS NULL OR ${t.weightGrams} > 0`),
    check("variants_currency_iso", sql`${t.currency} IS NULL OR ${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

export const photos = pgTable(
  "photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importId: uuid("import_id").notNull().references(() => imports.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    path: text("path").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    mediaType: text("media_type").notNull(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    sku: text("sku"),
    matchMethod: text("match_method").notNull(),
    matchScore: integer("match_score").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("photos_import_file_uq").on(t.importId, t.fileName),
    index("photos_product_idx").on(t.productId),
  ],
);

export const translations = pgTable(
  "translations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    locale: text("locale").notNull(),
    field: text("field").notNull(),
    text: text("text").notNull(),
    status: translationStatus("status").notNull(),
    /** sha256 of the English source this translation was made from. */
    sourceHash: text("source_hash").notNull(),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("translations_product_locale_field_uq").on(t.productId, t.locale, t.field),
    index("translations_status_idx").on(t.locale, t.status),
  ],
);

export const translationCache = pgTable("translation_cache", {
  hash: text("hash").primaryKey(),
  locale: text("locale").notNull(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiCalls = pgTable(
  "ai_calls",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    importId: uuid("import_id").references(() => imports.id, { onDelete: "set null" }),
    kind: text("kind").$type<"build" | "translate">().notNull(),
    model: text("model").notNull(),
    mode: text("mode").$type<"sync" | "batch">().notNull(),
    productCount: integer("product_count").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costNanos: bigint("cost_nanos", { mode: "number" }).notNull().default(0),
    /** What the same tokens would cost on the strong model, synchronously, without caching. */
    baselineNanos: bigint("baseline_nanos", { mode: "number" }).notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    outcome: text("outcome").$type<"ok" | "invalid_output" | "error" | "rate_limited">().notNull(),
    error: text("error"),
    vision: boolean("vision").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_calls_created_idx").on(t.createdAt), index("ai_calls_import_idx").on(t.importId)],
);

export const aiBatches = pgTable(
  "ai_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importId: uuid("import_id").notNull().references(() => imports.id, { onDelete: "cascade" }),
    providerBatchId: text("provider_batch_id"),
    status: text("status").$type<"submitting" | "in_progress" | "ended" | "applied" | "failed" | "fallback">().notNull(),
    /** custom_id → products + model in that request */
    requests: jsonb("requests").$type<Record<string, BatchRequestEntry>>().notNull(),
    error: text("error"),
    ...timestamps,
  },
  (t) => [uniqueIndex("ai_batches_provider_uq").on(t.providerBatchId), index("ai_batches_import_idx").on(t.importId)],
);

export interface BatchRequestEntry {
  productIds: string[];
  model: string;
  route: "cheap" | "strong";
  vision?: boolean;
  /** Set once this request's result has been written, so re-polling never double-applies. */
  applied?: boolean;
}

export interface StorefrontLocaleData {
  title: string;
  descriptionHtml: string;
  tags: string[];
  /** Translated attribute values (same keys as `StorefrontData.attributes`); absent in older snapshots. */
  attributes?: Record<string, string>;
}

export interface StorefrontData {
  locales: Record<string, StorefrontLocaleData>;
  variants: Array<{ sku: string; options: Record<string, string>; priceCents: number | null; currency: string | null; weightGrams: number | null }>;
  photos: string[];
  attributes: Record<string, string>;
}

/** The only table storefront pages read: a published snapshot written on approval. */
export const storefrontProducts = pgTable(
  "storefront_products",
  {
    handle: text("handle").primaryKey(),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    data: jsonb("data").$type<StorefrontData>().notNull(),
    priceMinCents: integer("price_min_cents"),
    currency: char("currency", { length: 3 }),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("storefront_product_uq").on(t.productId), index("storefront_category_idx").on(t.category, t.handle)],
);
