import { env } from "@/lib/env";
import type { ProductInput, Usage } from "./types";

export interface BuildRequest {
  model: string;
  products: ProductInput[];
  vision: boolean;
  repairHint?: string;
}

export interface TranslateRequest {
  model: string;
  locale: "de" | "fr";
  items: Array<{ id: string; text: string }>;
  keep: string[];
  repairHints?: Record<string, string>;
}

export interface CallResult {
  /** Parsed JSON the model produced (not yet validated). */
  output: unknown;
  usage: Usage;
  latencyMs: number;
}

export interface BatchItem {
  customId: string;
  request: BuildRequest;
}

export type BatchResult =
  | { customId: string; ok: true; output: unknown; usage: Usage }
  | { customId: string; ok: false; error: string };

export interface AiProvider {
  readonly name: "mock" | "anthropic";
  build(req: BuildRequest): Promise<CallResult>;
  translate(req: TranslateRequest): Promise<CallResult>;
  /** Message Batches API. Returns the provider batch id. */
  submitBatch(items: BatchItem[], idempotencyKey: string): Promise<string>;
  batchStatus(batchId: string): Promise<"in_progress" | "ended">;
  batchResults(batchId: string): AsyncIterable<BatchResult>;
}

let provider: AiProvider | undefined;

export async function getProvider(): Promise<AiProvider> {
  if (!provider) {
    if (env().AI_PROVIDER === "anthropic") {
      const { AnthropicProvider } = await import("./anthropic");
      provider = new AnthropicProvider();
    } else {
      const { MockProvider } = await import("./mock");
      provider = new MockProvider();
    }
  }
  return provider;
}

export function setProviderForTests(p: AiProvider | undefined): void {
  provider = p;
}
