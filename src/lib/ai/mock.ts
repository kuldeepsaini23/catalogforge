import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sanitizeOutputHtml, escapeHtml } from "@/lib/cleaning/html";
import { sha256, titleCase, tokenize } from "@/lib/cleaning/text";
import { env } from "@/lib/env";
import { resolveStoragePath } from "@/lib/storage";
import { TAXONOMY } from "@/lib/taxonomy";
import { findTerms } from "./claims";
import { RateLimitedError, TransientAiError, sleep } from "./errors";
import { BUILD_SYSTEM_PROMPT, TRANSLATE_SYSTEM_PROMPT, buildUserPrompt, translateUserPrompt } from "./prompts";
import type { AiProvider, BatchItem, BatchResult, BuildRequest, CallResult, TranslateRequest } from "./provider";
import type { AiWireProduct } from "./schema";
import type { ProductInput, Usage } from "./types";

/** Deterministic 0..1 from a string. */
function unit(seed: string): number {
  return parseInt(sha256(seed).slice(0, 8), 16) / 0xffffffff;
}

const tokens = (s: string) => Math.ceil(s.length / 4);

/** Keyword → taxonomy leaf (EN/DE/FR). Order matters: more specific first. */
const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/watering can|gie(ss|ß)kanne|arrosoir/i, "Watering Cans"],
  [/bird ?feeder|vogelfutter|mangeoire/i, "Bird Feeders"],
  [/plant stand|pflanzenständer/i, "Plant Stands"],
  [/planter|pot\b|topf|blumentopf|pflanzgef|cache-pot|jardinière/i, "Planters & Pots"],
  [/vase/i, "Vases"],
  [/candle|kerze|bougie|photophore/i, "Candles & Holders"],
  [/lantern|laterne|lanterne|solar/i, "Outdoor Lighting"],
  [/lamp|lampe|leuchte/i, "Table Lamps"],
  [/pendant|hängeleuchte|suspension/i, "Pendant Lights"],
  [/cushion|kissen|coussin/i, "Cushions & Covers"],
  [/throw|blanket|decke|plaid/i, "Throws & Blankets"],
  [/rug|teppich|tapis/i, "Rugs"],
  [/towel|handtuch|serviette de bain/i, "Towels"],
  [/napkin|serviette/i, "Napkins"],
  [/tablecloth|tischdecke|nappe/i, "Tablecloths"],
  [/mug|cup|tasse|becher/i, "Mugs & Cups"],
  [/bowl|schale|schüssel|bol\b/i, "Bowls"],
  [/plate|teller|assiette/i, "Plates"],
  [/glass|glas|verre|tumbler/i, "Glassware"],
  [/jug|carafe|karaffe|krug|pichet/i, "Jugs & Carafes"],
  [/board|brett|planche/i, "Serving Boards"],
  [/jar|vorratsglas|dose|bocal/i, "Storage Jars"],
  [/basket|korb|panier/i, "Baskets & Storage"],
  [/frame|bilderrahmen|cadre/i, "Picture Frames"],
  [/mirror|spiegel|miroir/i, "Mirrors"],
  [/clock|uhr|horloge/i, "Clocks"],
  [/stool|hocker|tabouret/i, "Stools"],
  [/notebook|notizbuch|carnet/i, "Notebooks"],
  [/soap|seife|savon/i, "Soap Dishes"],
];

const TITLE_WORDS: Record<string, string> = {
  blumentopf: "Planter", topf: "Pot", pflanzgefäß: "Planter", vase: "Vase", tasse: "Mug", becher: "Mug",
  schale: "Bowl", schüssel: "Bowl", teller: "Plate", kissen: "Cushion", kissenbezug: "Cushion Cover", decke: "Throw",
  kerze: "Candle", kerzenhalter: "Candle Holder", lampe: "Lamp", korb: "Basket", glas: "Glass", brett: "Board",
  krug: "Jug", karaffe: "Carafe", handtuch: "Towel", teppich: "Rug", gießkanne: "Watering Can", leinen: "Linen",
  steingut: "Stoneware", terrakotta: "Terracotta", keramik: "Ceramic", holz: "Wooden", eiche: "Oak", aus: "",
  bol: "Bowl", assiette: "Plate", coussin: "Cushion", plaid: "Throw", bougie: "Candle", panier: "Basket",
  verre: "Glass", planche: "Board", carafe: "Carafe", tapis: "Rug", arrosoir: "Watering Can", lin: "Linen",
  grès: "Stoneware", "terre cuite": "Terracotta", céramique: "Ceramic", bois: "Wood", chêne: "Oak", en: "", de: "",
  glasiertes: "Glazed", glasvase: "Glass Vase", keramikschale: "Ceramic Bowl", eichen: "Oak",
  servierbrett: "Serving Board", sojakerze: "Soy Candle", rattankorb: "Rattan Basket", emaille: "Enamel",
  jute: "Jute", baumwoll: "Cotton", geschirrtuch: "Tea Towel", housse: "Cover", torchon: "Tea Towel", mug: "Mug",
  "émaillé": "Glazed", "cache-pot": "Planter", "fabriqué": "", "coton": "Cotton", "rotin": "Rattan", "émail": "Enamel", soja: "Soy", service: "Serving",
};

function englishTitle(input: ProductInput): { title: string; translated: boolean } {
  const hint = input.facts.title ?? input.rows[0]?.cells[Object.keys(input.rows[0].cells)[0]] ?? input.key;
  const lang = input.facts.title_language;
  if (lang !== "de" && lang !== "fr") return { title: titleCase(hint), translated: false };
  const words = hint.split(/\s+/).map((w) => {
    const t = TITLE_WORDS[w.toLowerCase()];
    return t === undefined ? w : t;
  });
  return { title: titleCase(words.filter(Boolean).join(" ")), translated: true };
}

function categoryFor(input: ProductInput, title: string): { path: string; confident: boolean } {
  const haystack = `${title} ${input.facts.category_hint ?? ""} ${input.facts.title ?? ""}`;
  for (const [re, leaf] of CATEGORY_RULES) {
    if (re.test(haystack)) return { path: TAXONOMY.find((p) => p.endsWith(`> ${leaf}`))!, confident: true };
  }
  return { path: "Home & Garden > Decor > Wall Art", confident: false };
}

function claimsFor(input: ProductInput): AiWireProduct["claims"] {
  const out: AiWireProduct["claims"] = [];
  const seen = new Set<string>();
  for (const r of input.rows) {
    for (const [column, value] of Object.entries(r.cells)) {
      for (const sentence of value.split(/(?<=[.;!?])\s+|\n+/)) {
        const hits = findTerms(sentence);
        const positive = hits.filter((h) => !h.negated);
        const negative = hits.filter((h) => h.negated && !positive.some((p) => p.term === h.term));
        if (hits.length === 0) continue;
        const key = hits.map((h) => `${h.term}:${h.negated}`).sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        const label = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
        const text = positive.length
          ? positive.map((h) => label(h.term)).join(", ") + (negative.length ? ` (not ${negative.map((h) => h.term).join(", not ")})` : "")
          : `Not ${negative.map((h) => h.term).join(", not ")}`;
        out.push({ text, source: `row ${r.row}, column ${column}`, quote: sentence.trim().replace(/[.;!?]$/, "") });
      }
    }
  }
  return out;
}

export function mockProduct(input: ProductInput): AiWireProduct {
  const { title, translated } = englishTitle(input);
  const category = categoryFor(input, title);
  const claims = claimsFor(input);
  const facts = input.facts;
  const roll = unit(`hallucinate:${input.key}`);

  const bullets: string[] = [];
  if (facts.material) bullets.push(`<li><strong>Material:</strong> ${escapeHtml(facts.material)}</li>`);
  if (facts.dimensions) bullets.push(`<li><strong>Dimensions:</strong> ${escapeHtml(facts.dimensions)}</li>`);
  if (facts.colours) bullets.push(`<li><strong>Colours:</strong> ${escapeHtml(facts.colours)}</li>`);
  for (const c of claims) {
    const longer = claims.some((o) => o !== c && o.text.length > c.text.length && o.text.toLowerCase().startsWith(c.text.toLowerCase()));
    if (!longer) bullets.push(`<li>${escapeHtml(c.text)}</li>`);
  }
  let intro = facts.description && facts.description_language === "en" ? facts.description : `${title}${facts.material ? ` made from ${facts.material.toLowerCase()}` : ""}.`;
  // ~3% of products: the "model" smuggles an unsupported claim into the copy (verifier must catch it).
  if (roll < 0.03) intro += " Fully frost-proof and dishwasher-safe.";
  const description_html = sanitizeOutputHtml(`<p>${escapeHtml(intro)}</p>${bullets.length ? `<ul>${bullets.join("")}</ul>` : ""}`);

  // ~4% of products: an invented claim citing a real cell whose text does not support it.
  if (roll >= 0.03 && roll < 0.07 && input.rows[0]) {
    const [column, value] = Object.entries(input.rows[0].cells)[0] ?? ["", ""];
    if (column && !findTerms(value).some((h) => h.term === "handmade")) {
      claims.push({ text: "Handmade", source: `row ${input.rows[0].row}, column ${column}`, quote: value.slice(0, 30) || "n/a" });
    }
  }

  const attributes: AiWireProduct["attributes"] = [];
  for (const name of ["material", "origin", "care", "dimensions", "brand"] as const) {
    if (facts[name]) attributes.push({ name, value: facts[name] });
  }
  const tags = [...new Set([
    ...tokenize(facts.colours ?? "").filter((t) => t.length > 2),
    ...(facts.material ? [facts.material.toLowerCase()] : []),
    category.path.split(" > ").pop()!.toLowerCase(),
  ])].slice(0, 8);

  const jitter = Math.round(unit(`conf:${input.key}`) * 4);
  const confidence: AiWireProduct["confidence"] = [
    { field: "title", score: (translated ? 86 : 95) + jitter },
    { field: "description", score: 88 + jitter },
    { field: "category", score: category.confident ? 90 + jitter : 48 + jitter },
    { field: "tags", score: 85 },
    ...attributes.map((a) => ({
      field: `attributes.${a.name}`,
      // ~3% of care instructions are judged ambiguous (exercises the low-confidence review path).
      score: a.name === "care" && unit(`care:${input.key}`) < 0.03 ? 64 : 90,
    })),
  ];
  const conflict = input.issues.find((i) => i.code === "conflict");
  return {
    key: input.key,
    title,
    description_html,
    category: category.path,
    tags,
    attributes,
    claims,
    confidence,
    needs_review: Boolean(conflict),
    review_reason: conflict ? "Supplier rows disagree" : null,
  };
}

const DE: Record<string, string> = {
  planter: "Pflanzgefäß", pot: "Topf", vase: "Vase", mug: "Becher", bowl: "Schale", plate: "Teller", cushion: "Kissen",
  cover: "Bezug", throw: "Plaid", candle: "Kerze", holder: "Halter", lamp: "Lampe", basket: "Korb", glass: "Glas",
  board: "Brett", jug: "Krug", towel: "Handtuch", rug: "Teppich", linen: "Leinen", stoneware: "Steinzeug",
  terracotta: "Terrakotta", ceramic: "Keramik", wooden: "Holz", oak: "Eiche", made: "hergestellt", from: "aus",
  and: "und", with: "mit", for: "für", the: "die", in: "in", not: "nicht", material: "Material", colours: "Farben",
  dimensions: "Maße", "frost-resistant": "frostbeständig", "frost-proof": "frostfest", handmade: "handgemacht",
  "dishwasher-safe": "spülmaschinenfest", large: "groß", small: "klein", natural: "natürlich", classic: "klassisch",
};
const FR: Record<string, string> = {
  planter: "jardinière", pot: "pot", vase: "vase", mug: "mug", bowl: "bol", plate: "assiette", cushion: "coussin",
  cover: "housse", throw: "plaid", candle: "bougie", holder: "support", lamp: "lampe", basket: "panier", glass: "verre",
  board: "planche", jug: "pichet", towel: "serviette", rug: "tapis", linen: "lin", stoneware: "grès",
  terracotta: "terre cuite", ceramic: "céramique", wooden: "en bois", oak: "chêne", made: "fabriqué", from: "en",
  and: "et", with: "avec", for: "pour", the: "le", in: "en", not: "pas", material: "Matériau", colours: "Couleurs",
  dimensions: "Dimensions", "frost-resistant": "résistant au gel", "frost-proof": "ingélif", handmade: "fait main",
  "dishwasher-safe": "lave-vaisselle", large: "grand", small: "petit", natural: "naturel", classic: "classique",
};

/** Word-level mock translation that leaves tags, placeholders, numbers and kept terms untouched. */
export function mockTranslate(text: string, locale: "de" | "fr", keep: string[]): string {
  const dict = locale === "de" ? DE : FR;
  const keepSet = new Set(keep.map((k) => k.toLowerCase()));
  return text
    .split(/(<[^>]+>|\{\{[^}]+\}\})/)
    .map((part) => {
      if (part.startsWith("<") || part.startsWith("{{")) return part;
      return part.replace(/[A-Za-zÀ-ÿ-]+/g, (w) => {
        if (keepSet.has(w.toLowerCase())) return w;
        const t = dict[w.toLowerCase()];
        if (!t) return w;
        return w[0] === w[0].toUpperCase() ? t.charAt(0).toUpperCase() + t.slice(1) : t;
      });
    })
    .join("");
}

interface MockBatchFile {
  createdAt: number;
  items: Array<{ customId: string; products: ProductInput[]; model: string }>;
}

export class MockProvider implements AiProvider {
  readonly name = "mock" as const;
  private calls = 0;
  private cacheWarm = new Set<string>();

  private usage(model: string, system: string, user: string, output: unknown): Usage {
    const sys = tokens(system);
    const warm = this.cacheWarm.has(model);
    this.cacheWarm.add(model);
    return {
      inputTokens: tokens(user),
      outputTokens: tokens(JSON.stringify(output)),
      cacheReadTokens: warm ? sys : 0,
      cacheWriteTokens: warm ? 0 : sys,
    };
  }

  private async faults(kind: string): Promise<"invalid" | null> {
    const n = ++this.calls;
    const e = env();
    await sleep(e.MOCK_LATENCY_MS);
    if (e.MOCK_RATE_LIMIT_EVERY > 0 && n % e.MOCK_RATE_LIMIT_EVERY === 0) {
      throw new RateLimitedError(3_000, "mock 429: rate limit");
    }
    const r = unit(`fault:${kind}:${n}:${process.pid}`);
    if (r < e.MOCK_FAULT_RATE / 2) throw new TransientAiError("mock 529: overloaded");
    if (r < e.MOCK_FAULT_RATE) return "invalid";
    return null;
  }

  async build(req: BuildRequest): Promise<CallResult> {
    const started = Date.now();
    const fault = await this.faults("build");
    const products = req.products.map(mockProduct);
    // An invalid answer drops the last product and corrupts a field — exercises zod + retry.
    const output = fault === "invalid" ? { products: products.slice(0, -1).map((p) => ({ ...p, confidence: "high" })) } : { products };
    return {
      output,
      usage: this.usage(req.model, BUILD_SYSTEM_PROMPT, buildUserPrompt(req.products, req.repairHint), output),
      latencyMs: Date.now() - started,
    };
  }

  async translate(req: TranslateRequest): Promise<CallResult> {
    const started = Date.now();
    const fault = await this.faults("translate");
    const items = req.items.map((i) => ({ id: i.id, text: mockTranslate(i.text, req.locale, req.keep) }));
    if (fault === "invalid" && items[0]) items[0] = { ...items[0], text: items[0].text.replace(/<\/?p>/, "").replace(/\d+/, "") };
    const output = { items };
    return {
      output,
      usage: this.usage(req.model, TRANSLATE_SYSTEM_PROMPT, translateUserPrompt(req.locale, req.items, req.keep), output),
      latencyMs: Date.now() - started,
    };
  }

  private batchPath(id: string): string {
    return resolveStoragePath(path.join("mock-batches", `${id}.json`));
  }

  async submitBatch(items: BatchItem[]): Promise<string> {
    await this.faults("batch-submit");
    const id = `mockbatch_${sha256(items.map((i) => i.customId).join(",") + Date.now()).slice(0, 16)}`;
    const file: MockBatchFile = {
      createdAt: Date.now(),
      items: items.map((i) => ({ customId: i.customId, products: i.request.products, model: i.request.model })),
    };
    await mkdir(path.dirname(this.batchPath(id)), { recursive: true });
    await writeFile(this.batchPath(id), JSON.stringify(file));
    return id;
  }

  async batchStatus(batchId: string): Promise<"in_progress" | "ended"> {
    const file = JSON.parse(await readFile(this.batchPath(batchId), "utf8")) as MockBatchFile;
    return Date.now() - file.createdAt >= env().MOCK_BATCH_DELAY_MS ? "ended" : "in_progress";
  }

  async *batchResults(batchId: string): AsyncIterable<BatchResult> {
    const file = JSON.parse(await readFile(this.batchPath(batchId), "utf8")) as MockBatchFile;
    for (const item of file.items) {
      const output = { products: item.products.map(mockProduct) };
      yield { customId: item.customId, ok: true, output, usage: this.usage(item.model, BUILD_SYSTEM_PROMPT, buildUserPrompt(item.products), output) };
    }
  }
}
