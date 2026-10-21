import { InvalidOutputError, withRetry } from "./errors";
import type { AiProvider, BuildRequest } from "./provider";
import { aiBuildResponseSchema, toDraft, type AiProductDraft } from "./schema";
import type { Usage } from "./types";

export interface AttemptLog {
  usage: Usage;
  latencyMs: number;
  outcome: "ok" | "invalid_output" | "error" | "rate_limited";
  error?: string;
  productCount: number;
}

/** Validates a raw model answer for a chunk. Every input key must come back exactly once. */
export function parseBuildOutput(output: unknown, expectedKeys: string[]): Map<string, AiProductDraft> {
  const parsed = aiBuildResponseSchema.safeParse(output);
  if (!parsed.success) {
    const first = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new InvalidOutputError(`Output failed schema validation (${first})`);
  }
  const drafts = new Map<string, AiProductDraft>();
  for (const p of parsed.data.products) {
    if (!expectedKeys.includes(p.key)) throw new InvalidOutputError(`Unexpected product key "${p.key}"`);
    if (drafts.has(p.key)) throw new InvalidOutputError(`Product key "${p.key}" returned twice`);
    drafts.set(p.key, toDraft(p));
  }
  const missing = expectedKeys.filter((k) => !drafts.has(k));
  if (missing.length) throw new InvalidOutputError(`Missing products: ${missing.join(", ")}`);
  return drafts;
}

/**
 * One chunk → validated drafts. Transient errors and invalid output are retried with exponential
 * backoff + jitter; after a schema failure the next attempt carries a repair hint. Rate limits and
 * fatal errors propagate to the job (rate limits pause the import).
 */
export async function buildChunk(
  provider: AiProvider,
  req: BuildRequest,
  opts: { attempts?: number; baseMs?: number; onAttempt?: (log: AttemptLog) => Promise<void> | void } = {},
): Promise<Map<string, AiProductDraft>> {
  const keys = req.products.map((p) => p.key);
  let repairHint: string | undefined;
  return withRetry(
    async () => {
      const started = Date.now();
      let result;
      try {
        result = await provider.build({ ...req, repairHint });
      } catch (err) {
        const invalid = err instanceof InvalidOutputError;
        if (invalid) repairHint = err.message;
        await opts.onAttempt?.({
          usage: (invalid && err.usage) || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          latencyMs: Date.now() - started,
          outcome: invalid ? "invalid_output" : (err as Error).name === "RateLimitedError" ? "rate_limited" : "error",
          error: (err as Error).message,
          productCount: keys.length,
        });
        throw err;
      }
      try {
        const drafts = parseBuildOutput(result.output, keys);
        await opts.onAttempt?.({ usage: result.usage, latencyMs: result.latencyMs, outcome: "ok", productCount: keys.length });
        return drafts;
      } catch (err) {
        repairHint = (err as Error).message;
        await opts.onAttempt?.({
          usage: result.usage,
          latencyMs: result.latencyMs,
          outcome: "invalid_output",
          error: repairHint,
          productCount: keys.length,
        });
        throw err;
      }
    },
    { attempts: opts.attempts ?? 3, baseMs: opts.baseMs ?? 1_000, maxMs: 30_000 },
  );
}
