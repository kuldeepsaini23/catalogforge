# CatalogForge — plan & data model

## Pipeline (each arrow is a pg-boss job; every job is idempotent)

```
POST /api/imports ──► store files on disk, insert `imports` row, enqueue import.ingest ──► 202
                                                                                    │
import.ingest   parse sheet (SheetJS) → clean rows (pure) → insert source_rows (ON CONFLICT DO NOTHING)
                → unzip/match photos → group rows into products → upsert products by stable_key
                → products whose content_hash == built_hash: rows inherit status, no AI
                → others: enqueue product.build chunks (sync) or import.batch-submit (Batches API)
product.build   route (Haiku | Sonnet+vision) → one call per chunk of N products → zod → claim
                verification → deterministic validation → write product+variants+row statuses in one tx
                → enqueue product.translate → maybe finalize
import.batch-*  submit Message Batch, persist id, poll with startAfter, apply results like product.build
product.translate  DE/FR per field, cache by sha256(locale+source), guards + retry, manual edits win
import.sweep    (cron, every 30s) re-enqueue work for rows still pending without a live job; finalize
import.finalize reconciliation; DB trigger refuses status=completed unless every row is terminal
```

## Data model (Drizzle, `src/lib/db/schema.ts`)

| table | purpose | key constraints |
|---|---|---|
| `imports` | one upload | `total_rows <= 10000`; trigger: `completed` only if rows == total_rows and all terminal |
| `source_rows` | one sheet row: raw cells, cleaned values + provenance, language, corrections, status | unique(import_id,row_number); status ∈ pending/done/needs_review/failed; reason required unless pending/done |
| `products` | stable product (`stable_key` = merchant + group key) with AI result, confidence, claims, status, content_hash/built_hash, edited fields | unique(stable_key), unique(handle) |
| `variants` | sku, options, price_cents (int), currency (char 3), weight_grams | unique(sku), price_cents >= 0 |
| `photos` | stored photo, matched product, match method/score | unique(import_id,file_name) |
| `translations` | product × locale × field; status machine/manual/out_of_date/failed; source_hash | unique(product_id,locale,field) |
| `translation_cache` | sha256(locale + source text) → text | pk hash |
| `ai_calls` | every model call: model, kind, batch?, tokens, cost, baseline cost, latency, outcome | — |
| `ai_batches` | Message Batches in flight (survive restarts) | unique(anthropic_batch_id) |
| `storefront_products` | published snapshot, the only table storefront pages read | pk handle |

## Day plan
Day 1: repo/DB/queue → cleaning + tests → upload → AI builder (mock + real) → review table → 200-row e2e.
Day 2: translation → routing + batches + cost → metrics → storefront → 10k run → crash-resume test → k6 → README.
