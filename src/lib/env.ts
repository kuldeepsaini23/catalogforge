import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === undefined || v === "" ? undefined : ["1", "true", "yes"].includes(v.toLowerCase()));

const schema = z
  .object({
    DATABASE_URL: z.string().url(),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    AI_PROVIDER: z.enum(["mock", "anthropic"]).default("mock"),
    ANTHROPIC_API_KEY: z.string().optional(),
    AI_MODEL_CHEAP: z.string().default("claude-haiku-4-5"),
    AI_MODEL_STRONG: z.string().default("claude-sonnet-4-5"),
    AI_BATCH_THRESHOLD: z.coerce.number().int().nonnegative().default(100),
    AI_USE_BATCH: bool.transform((v) => v ?? true),
    AI_PRODUCTS_PER_CALL_CHEAP: z.coerce.number().int().min(1).max(25).default(8),
    AI_PRODUCTS_PER_CALL_STRONG: z.coerce.number().int().min(1).max(10).default(4),
    AI_MIN_CONFIDENCE: z.coerce.number().int().min(0).max(100).default(70),
    STORAGE_DIR: z.string().default("./data"),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    MOCK_LATENCY_MS: z.coerce.number().int().nonnegative().default(40),
    MOCK_FAULT_RATE: z.coerce.number().min(0).max(1).default(0),
    MOCK_RATE_LIMIT_EVERY: z.coerce.number().int().nonnegative().default(0),
    MOCK_BATCH_DELAY_MS: z.coerce.number().int().nonnegative().default(2000),
  })
  .superRefine((v, ctx) => {
    if (v.AI_PROVIDER === "anthropic" && !v.ANTHROPIC_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["ANTHROPIC_API_KEY"], message: "ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic" });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parsed environment. Read lazily so tests can set process.env before first use. */
export function env(): Env {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

export function resetEnvForTests(): void {
  cached = undefined;
}
