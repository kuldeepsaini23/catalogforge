import type { Usage } from "./types";

/** Prices in nano-USD per token (1 USD = 1e9). $1 / MTok = 1000 nano-USD per token. */
interface Price {
  input: number;
  output: number;
}

const PRICES: Record<string, Price> = {
  "claude-haiku-4-5": { input: 1_000, output: 5_000 },
  "claude-sonnet-4-5": { input: 3_000, output: 15_000 },
  "claude-sonnet-4-6": { input: 3_000, output: 15_000 },
  "claude-haiku-5-5": { input: 100, output: 500 },
  "claude-sonnet-5-5": { input: 2_000, output: 10_000 },
  "claude-sonnet-5": { input: 2_000, output: 10_000 },
  "claude-opus-5-5": { input: 4_000, output: 20_000 },
};

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;
const BATCH_DISCOUNT = 0.5;

export function priceOf(model: string): Price {
  const p = PRICES[model];
  if (!p) throw new Error(`No price configured for model "${model}" (add it to src/lib/ai/pricing.ts)`);
  return p;
}

/** Actual cost of a call in integer nano-USD. */
export function costNanos(model: string, usage: Usage, mode: "sync" | "batch"): number {
  const p = priceOf(model);
  const raw =
    usage.inputTokens * p.input +
    usage.cacheWriteTokens * p.input * CACHE_WRITE_MULTIPLIER +
    usage.cacheReadTokens * p.input * CACHE_READ_MULTIPLIER +
    usage.outputTokens * p.output;
  return Math.round(mode === "batch" ? raw * BATCH_DISCOUNT : raw);
}

/**
 * Baseline: the same work done the naive way — always the strong model, synchronous, no prompt
 * caching (every cached token billed as fresh input). The gap to `costNanos` is what routing,
 * batching and caching saved.
 */
export function baselineNanos(strongModel: string, usage: Usage): number {
  const p = priceOf(strongModel);
  const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return Math.round(input * p.input + usage.outputTokens * p.output);
}

export function formatUsd(nanos: number): string {
  const usd = nanos / 1e9;
  if (usd !== 0 && Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
