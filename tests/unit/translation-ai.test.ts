import { describe, expect, it, vi } from "vitest";
import { parseBuildOutput } from "@/lib/ai/build";
import { backoffDelay, FatalAiError, InvalidOutputError, RateLimitedError, TransientAiError, withRetry } from "@/lib/ai/errors";
import { mockProduct, mockTranslate } from "@/lib/ai/mock";
import { baselineNanos, costNanos } from "@/lib/ai/pricing";
import { routeProduct } from "@/lib/ai/routing";
import { toApiJsonSchema, aiBuildResponseSchema } from "@/lib/ai/schema";
import type { ProductInput } from "@/lib/ai/types";
import { numbers, placeholders, tagSequence, verifyTranslation } from "@/lib/translate/guards";
import { languageForCountry } from "@/lib/translate/locales";
import { plan } from "@/lib/translate/run";

describe("country → language", () => {
  it.each([
    ["DE", "de"], ["AT", "de"], ["CH-de", "de"], ["ch-DE", "de"], ["FR", "fr"], ["BE-fr", "fr"],
    ["CH-fr", "en"], ["BE-nl", "en"], ["US", "en"], ["", "en"], [null, "en"],
  ])("%s → %s", (country, lang) => {
    expect(languageForCountry(country)).toBe(lang);
  });
});

describe("translation guards", () => {
  const src = '<p>The <strong>Atelier Nord</strong> pot holds {{capacity}} and measures 30 cm, 1.5 l.</p><ul><li>Frost-resistant</li></ul>';
  it("accepts a faithful translation (decimal comma allowed)", () => {
    const de = '<p>Der <strong>Atelier Nord</strong> Topf fasst {{capacity}} und misst 30 cm, 1,5 l.</p><ul><li>Frostbeständig</li></ul>';
    expect(verifyTranslation(src, de, ["Atelier Nord"])).toEqual([]);
  });
  it("rejects broken tags, placeholders, numbers and brand names", () => {
    const bad = "<p>Der Topf fasst {{Kapazität}} und misst 31 cm.</p>";
    const problems = verifyTranslation(src, bad, ["Atelier Nord"]);
    expect(problems).toEqual([
      expect.stringMatching(/HTML tags changed/),
      expect.stringMatching(/placeholders changed/),
      expect.stringMatching(/numbers\/units changed/),
      '"Atelier Nord" must stay unchanged',
    ]);
  });
  it("rejects empty and unsafe output", () => {
    expect(verifyTranslation(src, "  ", [])).toEqual(["empty translation"]);
    expect(verifyTranslation("<p>x</p>", '<p onclick="a()">x</p>', [])).toContain("unsafe markup in translation");
  });
  it("extracts the protected parts", () => {
    expect(tagSequence(src)).toEqual(["p", "strong", "/strong", "/p", "ul", "li", "/li", "/ul"]);
    expect(placeholders(src)).toEqual(["{{capacity}}"]);
    expect(numbers(src)).toEqual(["1.5l", "30cm"]);
  });
  it("the mock translator itself respects the guards", () => {
    expect(verifyTranslation(src, mockTranslate(src, "de", ["Atelier Nord"]), ["Atelier Nord"])).toEqual([]);
    expect(verifyTranslation(src, mockTranslate(src, "fr", ["Atelier Nord"]), ["Atelier Nord"])).toEqual([]);
  });
});

describe("manual edits win", () => {
  it.each([
    [undefined, "h1", "translate"],
    [{ status: "machine" as const, sourceHash: "h1" }, "h1", "skip"],
    [{ status: "machine" as const, sourceHash: "h0" }, "h1", "translate"],
    [{ status: "failed" as const, sourceHash: "h1" }, "h1", "translate"],
    [{ status: "manual" as const, sourceHash: "h1" }, "h1", "skip"],
    [{ status: "manual" as const, sourceHash: "h0" }, "h1", "mark_out_of_date"],
    [{ status: "out_of_date" as const, sourceHash: "h0" }, "h1", "skip"],
    [{ status: "out_of_date" as const, sourceHash: "h1" }, "h1", "mark_manual"],
  ])("%o with English %s → %s", (existing, hash, action) => {
    expect(plan(existing, hash)).toBe(action);
  });
});

describe("retry with backoff + jitter", () => {
  it("retries transient errors and invalid output, then succeeds", async () => {
    const sleep = vi.fn(async () => undefined);
    let n = 0;
    const result = await withRetry(
      async () => {
        n++;
        if (n === 1) throw new TransientAiError("529");
        if (n === 2) throw new InvalidOutputError("bad json");
        return "ok";
      },
      { attempts: 3, baseMs: 100, maxMs: 1000, sleep, random: () => 0.5 },
    );
    expect(result).toBe("ok");
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([75, 150]);
  });

  it("does not retry rate limits or fatal errors (the import pauses instead)", async () => {
    const sleep = vi.fn(async () => undefined);
    await expect(withRetry(async () => { throw new RateLimitedError(5000); }, { attempts: 3, baseMs: 1, maxMs: 1, sleep })).rejects.toBeInstanceOf(RateLimitedError);
    await expect(withRetry(async () => { throw new FatalAiError("400"); }, { attempts: 3, baseMs: 1, maxMs: 1, sleep })).rejects.toBeInstanceOf(FatalAiError);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("caps exponential delays and always adds jitter within [cap/2, cap]", () => {
    for (let a = 0; a < 10; a++) {
      const d = backoffDelay(a, 1000, 30_000, Math.random);
      const cap = Math.min(30_000, 1000 * 2 ** a);
      expect(d).toBeGreaterThanOrEqual(cap / 2);
      expect(d).toBeLessThanOrEqual(cap);
    }
  });
});

const baseInput: ProductInput = {
  key: "P:a",
  rows: [{ row: 2, language: "en", cells: { Title: "Stoneware Mug", Description: "A sturdy stoneware mug for everyday coffee and tea at home." } }],
  variants: [{ sku: "A", options: {}, price_cents: 100, currency: "EUR", weight_grams: 300, rows: [2] }],
  facts: { title: "Stoneware Mug" },
  photos: [],
  issues: [],
  languages: ["en"],
};

describe("model routing", () => {
  it("sends clean rows (incl. clean German) to the cheap model", () => {
    expect(routeProduct(baseInput).route).toBe("cheap");
    expect(routeProduct({ ...baseInput, languages: ["de"] }).route).toBe("cheap");
  });
  it("escalates conflicts and mixed languages to the strong model", () => {
    expect(routeProduct({ ...baseInput, languages: ["en", "de"] }).route).toBe("strong");
    expect(routeProduct({ ...baseInput, issues: [{ row: 2, code: "conflict", message: "x", blocking: true }] }).route).toBe("strong");
  });
  it("uses vision only when photos must fill a missing description", () => {
    const photo = { id: "p", fileName: "a.jpg", path: "a.jpg", mediaType: "image/jpeg" };
    expect(routeProduct({ ...baseInput, photos: [photo] }).vision).toBe(false);
    const thin = { ...baseInput, rows: [{ row: 2, language: "en" as const, cells: { Title: "Mug" } }], photos: [photo] };
    expect(routeProduct(thin)).toMatchObject({ route: "strong", vision: true });
  });
});

describe("pricing", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
  it("prices Haiku 4.5 and Sonnet 4.5 per MTok, batch at 50%", () => {
    expect(costNanos("claude-haiku-4-5", usage, "sync")).toBe(1_500_000_000); // $1 + $0.50
    expect(costNanos("claude-haiku-4-5", usage, "batch")).toBe(750_000_000);
    expect(costNanos("claude-sonnet-4-5", usage, "sync")).toBe(4_500_000_000); // $3 + $1.50
  });
  it("bills cache reads at 10% and the baseline as uncached strong-model input", () => {
    const cached = { ...usage, inputTokens: 0, cacheReadTokens: 1_000_000 };
    expect(costNanos("claude-haiku-4-5", cached, "sync")).toBe(600_000_000);
    expect(baselineNanos("claude-sonnet-4-5", cached)).toBe(4_500_000_000);
  });
});

describe("structured output", () => {
  it("validates model output: every key back exactly once", () => {
    const out = { products: [mockProduct(baseInput)] };
    expect(parseBuildOutput(out, ["P:a"]).get("P:a")?.title).toBe("Stoneware Mug");
    expect(() => parseBuildOutput(out, ["P:a", "P:b"])).toThrow(/Missing products: P:b/);
    expect(() => parseBuildOutput({ products: [{ ...out.products[0], confidence: "high" }] }, ["P:a"])).toThrow(InvalidOutputError);
    expect(() => parseBuildOutput("not json", ["P:a"])).toThrow(InvalidOutputError);
  });
  it("emits an API JSON schema without unsupported keywords, all objects closed", () => {
    const json = JSON.stringify(toApiJsonSchema(aiBuildResponseSchema));
    expect(json).not.toMatch(/minLength|maxLength|"pattern"|\$schema|"maximum"/);
    expect(json).toMatch(/"additionalProperties":false/);
  });
});
