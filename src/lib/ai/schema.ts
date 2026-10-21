import { z } from "zod";

/**
 * Wire format the model must produce. Maps are arrays of {name,value} so the same schema works for
 * forced tool use and for strict structured outputs (which forbid open-ended object keys).
 */
export const aiWireProductSchema = z.object({
  key: z.string().min(1).describe("The product key from the input, unchanged"),
  title: z.string().min(2).max(150).describe("Clean English product title without variant options"),
  description_html: z.string().min(1).max(10_000).describe("English description using only <p>, <ul>, <li>, <strong>, <em>"),
  category: z.string().min(3).describe("Exactly one path from the taxonomy list"),
  tags: z.array(z.string().min(1).max(40)).max(20),
  attributes: z.array(z.object({ name: z.string().min(1).max(40), value: z.string().min(1).max(300) })).max(30),
  claims: z
    .array(
      z.object({
        text: z.string().min(2).max(300).describe("The claim in English, no stronger than the source"),
        source: z.string().regex(/^row \d+, column .+$/).describe('Exactly "row <n>, column <header>"'),
        quote: z.string().min(2).max(500).describe("Verbatim text copied from that cell supporting the claim"),
      }),
    )
    .max(20),
  confidence: z
    .array(z.object({ field: z.string().min(1), score: z.number().int().min(0).max(100) }))
    .describe('Per-field confidence 0-100, fields like "title", "category", "description", "attributes.care"'),
  needs_review: z.boolean(),
  review_reason: z.string().max(500).nullable(),
});
export type AiWireProduct = z.infer<typeof aiWireProductSchema>;

export const aiBuildResponseSchema = z.object({ products: z.array(aiWireProductSchema) });
export type AiBuildResponse = z.infer<typeof aiBuildResponseSchema>;

export interface AiProductDraft {
  key: string;
  title: string;
  description_html: string;
  category: string;
  tags: string[];
  attributes: Record<string, string>;
  claims: Array<{ text: string; source: string; quote: string }>;
  confidence: Record<string, number>;
  needs_review: boolean;
  review_reason: string | null;
}

export function toDraft(w: AiWireProduct): AiProductDraft {
  const attributes: Record<string, string> = {};
  for (const a of w.attributes) attributes[a.name.trim().toLowerCase().replace(/\s+/g, "_")] = a.value.trim();
  const confidence: Record<string, number> = {};
  for (const c of w.confidence) confidence[c.field.trim()] = c.score;
  return { ...w, attributes, confidence };
}

const confidence = z.record(z.string(), z.number().int().min(0).max(100));

/** Final per-product JSON — the exact shape of the export. */
export const catalogProductSchema = z.object({
  title: z.string().min(2),
  handle: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description_html: z.string(),
  category: z.string(),
  tags: z.array(z.string()),
  attributes: z.record(z.string(), z.string()),
  variants: z
    .array(
      z.object({
        sku: z.string().min(1),
        options: z.record(z.string(), z.string()),
        price_cents: z.number().int().positive().nullable(),
        currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
        weight_grams: z.number().int().positive().nullable(),
      }),
    )
    .min(1),
  claims: z.array(z.object({ text: z.string(), source: z.string() })),
  confidence,
  status: z.enum(["done", "needs_review"]),
  review_reason: z.string().nullable(),
  source_rows: z.array(z.number().int().positive()),
});
export type CatalogProduct = z.infer<typeof catalogProductSchema>;

export const translationResponseSchema = z.object({
  items: z.array(z.object({ id: z.string(), text: z.string() })),
});
export type TranslationResponse = z.infer<typeof translationResponseSchema>;

/** JSON Schema for the API: drops keywords structured outputs don't support and closes objects. */
export function toApiJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  return strip(json) as Record<string, unknown>;
}

const UNSUPPORTED = new Set(["$schema", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "pattern", "exclusiveMinimum", "exclusiveMaximum"]);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) if (!UNSUPPORTED.has(k)) out[k] = strip(v);
  if (out.type === "object") out.additionalProperties = false;
  return out;
}
