import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { readStoredFile } from "@/lib/storage";
import { FatalAiError, InvalidOutputError, RateLimitedError, TRUNCATED, TransientAiError } from "./errors";
import { BUILD_SYSTEM_PROMPT, TRANSLATE_SYSTEM_PROMPT, buildUserPrompt, translateUserPrompt } from "./prompts";
import type { AiProvider, BatchItem, BatchResult, BuildRequest, CallResult, TranslateRequest } from "./provider";
import { aiBuildResponseSchema, toApiJsonSchema, translationResponseSchema } from "./schema";
import type { Usage } from "./types";

const BUILD_TOOL = "submit_products";
const TRANSLATE_TOOL = "submit_translations";
const MAX_IMAGE_BYTES = 3_750_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_PHOTOS_PER_PRODUCT = 2;

const BUILD_SCHEMA = toApiJsonSchema(aiBuildResponseSchema);
const TRANSLATE_SCHEMA = toApiJsonSchema(translationResponseSchema);

/** Newer models reject forced tool_choice; they get structured outputs instead. */
function supportsForcedTool(model: string): boolean {
  return !/(opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1)/.test(model);
}

/**
 * Vercel AI Gateway names models "anthropic/claude-haiku-4.5"; the rest of the app (pricing,
 * routing, logs) keeps Anthropic's ids, so the translation happens only at the wire.
 */
export function wireModel(model: string, gateway: boolean): string {
  if (!gateway || model.includes("/")) return model;
  return `anthropic/${model.replace(/-(\d+)-(\d+)$/, "-$1.$2")}`;
}

function usageOf(u: Anthropic.Usage | undefined): Usage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

/** Maps SDK errors onto our retry classes. */
export function classifyError(err: unknown): Error {
  if (err instanceof Anthropic.RateLimitError) {
    const retryAfter = Number(err.headers?.get("retry-after"));
    return new RateLimitedError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000, err.message);
  }
  if (err instanceof Anthropic.APIConnectionError) return new TransientAiError(err.message);
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    if (status === 408 || status === 409 || status >= 500) return new TransientAiError(`${status} ${err.message}`);
    return new FatalAiError(`${status} ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function invalid(message: Anthropic.Message, text: string): InvalidOutputError {
  const err = new InvalidOutputError(text);
  err.usage = usageOf(message.usage);
  return err;
}

function extractJson(message: Anthropic.Message, toolName: string): unknown {
  if (message.stop_reason === "max_tokens") throw invalid(message, TRUNCATED);
  if (message.stop_reason === "refusal") throw invalid(message, "Model refused the request");
  for (const block of message.content) {
    if (block.type === "tool_use" && block.name === toolName) return block.input;
  }
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    return JSON.parse(text);
  } catch {
    throw invalid(message, "Response was not valid JSON");
  }
}

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic" as const;
  private gateway = Boolean(env().AI_GATEWAY_API_KEY);
  private client = new Anthropic({
    apiKey: env().AI_GATEWAY_API_KEY ?? env().ANTHROPIC_API_KEY,
    baseURL: this.gateway ? env().AI_GATEWAY_BASE_URL : undefined,
    maxRetries: 0,
    timeout: 120_000,
  });

  private async buildParams(req: BuildRequest): Promise<Anthropic.MessageCreateParamsNonStreaming> {
    const content: Anthropic.ContentBlockParam[] = [];
    if (req.vision) {
      for (const p of req.products) {
        for (const photo of p.photos.slice(0, MAX_PHOTOS_PER_PRODUCT)) {
          if (!IMAGE_TYPES.has(photo.mediaType)) continue;
          const data = await readStoredFile(photo.path);
          if (data.byteLength > MAX_IMAGE_BYTES) continue;
          content.push({ type: "text", text: `Photo for product key ${p.key} (${photo.fileName}):` });
          content.push({
            type: "image",
            source: { type: "base64", media_type: photo.mediaType as "image/jpeg", data: Buffer.from(data).toString("base64") },
          });
        }
      }
    }
    content.push({ type: "text", text: buildUserPrompt(req.products, req.repairHint) });
    return this.structuredParams(req.model, BUILD_SYSTEM_PROMPT, content, BUILD_TOOL, BUILD_SCHEMA, Math.min(16_000, 1_000 + req.products.length * 1_400), "Submit one product record per input product.");
  }

  private structuredParams(
    model: string,
    system: string,
    content: Anthropic.ContentBlockParam[],
    toolName: string,
    schema: Record<string, unknown>,
    maxTokens: number,
    toolDescription: string,
  ): Anthropic.MessageCreateParamsNonStreaming {
    const base = {
      model: wireModel(model, this.gateway),
      max_tokens: maxTokens,
      system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }],
      messages: [{ role: "user" as const, content }],
    };
    if (supportsForcedTool(model)) {
      return {
        ...base,
        tools: [{ name: toolName, description: toolDescription, input_schema: schema as Anthropic.Tool.InputSchema }],
        tool_choice: { type: "tool", name: toolName },
      };
    }
    return { ...base, output_config: { format: { type: "json_schema", schema } } };
  }

  async build(req: BuildRequest): Promise<CallResult> {
    const params = await this.buildParams(req);
    const started = Date.now();
    try {
      const message = await this.client.messages.create(params);
      return { output: extractJson(message, BUILD_TOOL), usage: usageOf(message.usage), latencyMs: Date.now() - started };
    } catch (err) {
      if (err instanceof InvalidOutputError) throw err;
      throw classifyError(err);
    }
  }

  async translate(req: TranslateRequest): Promise<CallResult> {
    const params = this.structuredParams(
      req.model,
      TRANSLATE_SYSTEM_PROMPT,
      [{ type: "text", text: translateUserPrompt(req.locale, req.items, req.keep, req.repairHints) }],
      TRANSLATE_TOOL,
      TRANSLATE_SCHEMA,
      // ~1 output token per source character: DE/FR run longer than English, and JSON escapes the HTML.
      Math.min(16_000, 1_000 + req.items.reduce((n, i) => n + i.text.length, 0)),
      "Submit one translation per input item.",
    );
    const started = Date.now();
    try {
      const message = await this.client.messages.create(params);
      return { output: extractJson(message, TRANSLATE_TOOL), usage: usageOf(message.usage), latencyMs: Date.now() - started };
    } catch (err) {
      if (err instanceof InvalidOutputError) throw err;
      throw classifyError(err);
    }
  }

  async submitBatch(items: BatchItem[], idempotencyKey: string): Promise<string> {
    const requests = await Promise.all(
      items.map(async (i) => ({ custom_id: i.customId, params: await this.buildParams(i.request) })),
    );
    try {
      // The gateway returns the existing batch when a submission is retried with the same key.
      const batch = await this.client.messages.batches.create({ requests }, { headers: { "Idempotency-Key": idempotencyKey } });
      return batch.id;
    } catch (err) {
      throw classifyError(err);
    }
  }

  async batchStatus(batchId: string): Promise<"in_progress" | "ended"> {
    try {
      const b = await this.client.messages.batches.retrieve(batchId);
      return b.processing_status === "ended" ? "ended" : "in_progress";
    } catch (err) {
      throw classifyError(err);
    }
  }

  async *batchResults(batchId: string): AsyncIterable<BatchResult> {
    for await (const r of await this.client.messages.batches.results(batchId)) {
      if (r.result.type === "succeeded") {
        try {
          yield { customId: r.custom_id, ok: true, output: extractJson(r.result.message, BUILD_TOOL), usage: usageOf(r.result.message.usage) };
        } catch (err) {
          yield { customId: r.custom_id, ok: false, error: (err as Error).message };
        }
      } else if (r.result.type === "errored") {
        yield { customId: r.custom_id, ok: false, error: `errored: ${r.result.error.error.type}` };
      } else {
        yield { customId: r.custom_id, ok: false, error: r.result.type };
      }
    }
  }
}
