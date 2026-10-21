import { and, eq, inArray } from "drizzle-orm";
import { withRetry, RateLimitedError, InvalidOutputError, TRUNCATED } from "@/lib/ai/errors";
import { getProvider } from "@/lib/ai/provider";
import { translationResponseSchema } from "@/lib/ai/schema";
import { sha256 } from "@/lib/cleaning/text";
import { getDb, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { logAiCall } from "@/lib/pipeline/build";
import { pauseImport, pausedUntil } from "@/lib/pipeline/pause";
import { refreshPublished } from "@/lib/publish";
import { QUEUES, send, type JobData } from "@/lib/queue";
import { verifyTranslation } from "./guards";
import { TARGET_LOCALES, TRANSLATED_FIELDS, type TargetLocale, type TranslatedField } from "./locales";

export const cacheKey = (locale: string, text: string) => sha256(`${locale}\n${text}`);
const MAX_ITEMS_PER_CALL = 20;
const MAX_CHARS_PER_CALL = 12_000;
const GUARD_ATTEMPTS = 3;

interface Item {
  id: string;
  productId: string;
  field: TranslatedField;
  text: string;
  sourceHash: string;
  keep: string[];
}

/**
 * Decides what each (product, locale, field) needs. Pure.
 * - manual edit + English changed → out_of_date (keep the merchant's text)
 * - out_of_date + English changed back → manual again
 * - machine translation of the same English → nothing to do
 */
export function plan(
  existing: { status: "machine" | "manual" | "out_of_date" | "failed"; sourceHash: string } | undefined,
  sourceHash: string,
): "skip" | "mark_out_of_date" | "mark_manual" | "translate" {
  if (!existing) return "translate";
  if (existing.status === "manual") return existing.sourceHash === sourceHash ? "skip" : "mark_out_of_date";
  if (existing.status === "out_of_date") return existing.sourceHash === sourceHash ? "mark_manual" : "skip";
  if (existing.status === "machine" && existing.sourceHash === sourceHash) return "skip";
  return "translate";
}

function chunk(items: Item[]): Item[][] {
  const out: Item[][] = [];
  let cur: Item[] = [];
  let chars = 0;
  for (const i of items) {
    if (cur.length && (cur.length >= MAX_ITEMS_PER_CALL || chars + i.text.length > MAX_CHARS_PER_CALL)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(i);
    chars += i.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** product.translate: ahead-of-time DE/FR translation with caching, guards and manual-edit rules. */
export async function handleTranslate(data: JobData[typeof QUEUES.translate]): Promise<void> {
  const db = getDb();
  if (data.importId) {
    const until = await pausedUntil(data.importId);
    if (until) {
      await send(QUEUES.translate, data, { startAfter: until });
      return;
    }
  }
  const products = await db
    .select()
    .from(schema.products)
    .where(and(inArray(schema.products.id, data.productIds), inArray(schema.products.status, ["done", "needs_review", "approved"])));
  if (!products.length) return;
  const existingRows = await db.select().from(schema.translations).where(inArray(schema.translations.productId, products.map((p) => p.id)));
  const existing = new Map(existingRows.map((t) => [`${t.productId}:${t.locale}:${t.field}`, t]));
  const provider = await getProvider();
  const model = env().AI_MODEL_CHEAP;

  for (const locale of TARGET_LOCALES) {
    const todo: Item[] = [];
    for (const p of products) {
      const keep = [p.attributes.brand, p.input?.facts.brand].filter((x): x is string => Boolean(x));
      for (const field of TRANSLATED_FIELDS) {
        const text = (field === "title" ? p.title : p.descriptionHtml) ?? "";
        if (!text) continue;
        const sourceHash = sha256(text);
        const ex = existing.get(`${p.id}:${locale}:${field}`);
        const action = plan(ex, sourceHash);
        if (action === "skip") continue;
        if (action === "mark_out_of_date" || action === "mark_manual") {
          await db
            .update(schema.translations)
            .set({ status: action === "mark_manual" ? "manual" : "out_of_date", updatedAt: new Date() })
            .where(eq(schema.translations.id, ex!.id));
          continue;
        }
        todo.push({ id: `${p.id}:${field}`, productId: p.id, field, text, sourceHash, keep });
      }
    }
    if (!todo.length) continue;

    // Cache by hash of the source text: identical English is never translated twice.
    const cached = await db
      .select()
      .from(schema.translationCache)
      .where(inArray(schema.translationCache.hash, todo.map((i) => cacheKey(locale, i.text))));
    const cache = new Map(cached.map((c) => [c.hash, c.text]));
    const misses: Item[] = [];
    for (const item of todo) {
      const hit = cache.get(cacheKey(locale, item.text));
      if (hit !== undefined) await saveTranslation(item, locale, hit, "machine");
      else misses.push(item);
    }

    for (const group of chunk(misses)) {
      try {
        await translateSplitting(provider, model, locale, group, data.importId);
      } catch (err) {
        if (err instanceof RateLimitedError) {
          if (data.importId) {
            const at = await pauseImport(data.importId, err.retryAfterMs, `Rate limited by AI provider: ${err.message}`);
            await send(QUEUES.translate, data, { startAfter: at });
          } else {
            await send(QUEUES.translate, data, { startAfter: new Date(Date.now() + err.retryAfterMs) });
          }
          return;
        }
        throw err;
      }
    }
  }
  await refreshPublished(products.filter((p) => p.status === "approved").map((p) => p.id));
}

/** The answer hit max_tokens: retrying the same request can't help, only a smaller one can. */
class OutputTooLong extends Error {}

/** A group whose output doesn't fit max_tokens is translated in halves. */
async function translateSplitting(
  provider: Awaited<ReturnType<typeof getProvider>>,
  model: string,
  locale: TargetLocale,
  group: Item[],
  importId: string | null,
): Promise<void> {
  try {
    await translateGroup(provider, model, locale, group, importId);
  } catch (err) {
    if (!(err instanceof OutputTooLong)) throw err;
    if (group.length === 1) {
      // Keep English as the visible fallback and flag it, like any other failed translation.
      await saveTranslation(group[0], locale, group[0].text, "failed", "Text too long to translate in one call");
      return;
    }
    const mid = Math.ceil(group.length / 2);
    await translateSplitting(provider, model, locale, group.slice(0, mid), importId);
    await translateSplitting(provider, model, locale, group.slice(mid), importId);
  }
}

async function translateGroup(
  provider: Awaited<ReturnType<typeof getProvider>>,
  model: string,
  locale: TargetLocale,
  group: Item[],
  importId: string | null,
): Promise<void> {
  let remaining = group;
  const hints: Record<string, string> = {};
  for (let attempt = 0; attempt < GUARD_ATTEMPTS && remaining.length; attempt++) {
    const keep = [...new Set(remaining.flatMap((i) => i.keep))];
    const result = await withRetry(
      async () => {
        const productCount = new Set(remaining.map((i) => i.productId)).size;
        let r;
        try {
          r = await provider.translate({ model, locale, items: remaining.map((i) => ({ id: i.id, text: i.text })), keep, repairHints: hints });
        } catch (err) {
          // A truncated or unparseable answer was still billed: record it.
          if (err instanceof InvalidOutputError && err.usage) {
            await logAiCall(importId, "translate", model, "sync", { usage: err.usage, latencyMs: 0, outcome: "invalid_output", error: err.message, productCount });
            if (err.message === TRUNCATED) throw new OutputTooLong(err.message);
          }
          throw err;
        }
        const parsed = translationResponseSchema.safeParse(r.output);
        await logAiCall(importId, "translate", model, "sync", {
          usage: r.usage,
          latencyMs: r.latencyMs,
          outcome: parsed.success ? "ok" : "invalid_output",
          productCount,
        });
        if (!parsed.success) throw new InvalidOutputError("Translation output failed schema validation");
        return parsed.data;
      },
      { attempts: 3, baseMs: 1_000, maxMs: 20_000 },
    );
    const byId = new Map(result.items.map((i) => [i.id, i.text]));
    const failed: Item[] = [];
    for (const item of remaining) {
      const text = byId.get(item.id);
      const problems = text === undefined ? ["missing from response"] : verifyTranslation(item.text, text, item.keep);
      if (problems.length === 0) {
        await saveTranslation(item, locale, text!, "machine");
        await getDb().insert(schema.translationCache).values({ hash: cacheKey(locale, item.text), locale, text: text! }).onConflictDoNothing();
      } else {
        hints[item.id] = problems.join("; ");
        failed.push(item);
      }
    }
    remaining = failed;
  }
  // Still broken after retries: keep English as the visible fallback and flag it.
  for (const item of remaining) await saveTranslation(item, locale, item.text, "failed", hints[item.id]);
}

async function saveTranslation(item: Item, locale: string, text: string, status: "machine" | "failed", error?: string): Promise<void> {
  await getDb()
    .insert(schema.translations)
    .values({ productId: item.productId, locale, field: item.field, text, status, sourceHash: item.sourceHash, error: error ?? null })
    .onConflictDoUpdate({
      target: [schema.translations.productId, schema.translations.locale, schema.translations.field],
      set: { text, status, sourceHash: item.sourceHash, error: error ?? null, updatedAt: new Date() },
      // Never overwrite a merchant's manual edit (or its out-of-date marker) with a machine translation.
      setWhere: inArray(schema.translations.status, ["machine", "failed"]),
    });
}
