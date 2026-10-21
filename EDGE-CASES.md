# EDGE-CASES.md

Everything that can go wrong, what CatalogForge does about it, and whether it is tested.

**Status key**
- ✅ handled and tested: an automated test exercises it (test file named)
- 🟡 handled, not tested: the code path exists, but no automated test covers it
- ❌ not handled: why, and what I'd do

> Honesty note: the brief (Notion) asks for this file to be the **first commit**. The brief I was
> working from in chat did not mention it, so it was written after the pipeline existed. The commit
> history shows that order truthfully. I did not rewrite it.

---

## 1. Messy input

| What happens | What the app does (and why) | Status |
|---|---|---|
| File is not CSV/XLSX (e.g. `.pdf`, `.json`) | Upload is rejected with `"x.pdf" is not a CSV or XLSX file`. Checked before anything is stored. | ✅ (manual + API check in `src/lib/imports.ts`) |
| Sheet is empty / header only | Import fails with "The sheet is empty" / "has a header row but no data rows". Nothing reaches the AI. | 🟡 |
| Sheet over 10,000 rows | Import fails with "The sheet has 12,345 rows; the limit is 10,000". DB check constraint also caps `total_rows`. | 🟡 |
| Sheet > 25 MB, photo > 15 MB, ZIP > 500 MB, > 2,000 photos | Rejected at upload with the exact size/limit in the message. ZIP image count is read from the ZIP directory without decompressing. | 🟡 |
| Corrupt XLSX / broken ZIP | "Could not read …" / "The ZIP file is corrupt or not a ZIP". | 🟡 |
| CSV in Windows-1252 instead of UTF-8 | Decoded as UTF-8 if valid, else Windows-1252. Delimiter sniffed (`,` `;` tab `|`). | ✅ `units-encoding.test.ts` (decoder), 🟡 sniffing |
| Mojibake (`GrÃ¼n`, `â‚¬`, double-encoded) | Repaired per run of bytes (UTF-8 read as CP1252/Latin-1), repeated for double encoding; the fix is recorded as a correction. Legit text is left alone. | ✅ `units-encoding.test.ts` |
| Prices: `1.299,00 €`, `12.5`, `£8`, `$1,299.00`, `EUR 24,99`, `24,-`, `CHF 1'299.50` | Parsed to **integer minor units + ISO currency** using string arithmetic, never floats. Bare numbers get the sheet's dominant currency and the inference is recorded. | ✅ `price.test.ts` |
| Ambiguous price `1.299` (1299.00 or 1.299?) | Read as thousands **and flagged blocking**: the product goes to Needs review with "Ambiguous price … please confirm". Never silently guessed. | ✅ `price.test.ts` |
| Missing price / `n/a` / `auf Anfrage` | No price is invented; variant gets `price_cents: null`, product → **Needs review** "Missing price for SKU X (row N)". Cannot be published until fixed. | ✅ `import.test.ts`, `claims.test.ts` |
| Zero / negative price | Invalid → blocking issue → Needs review. DB check `price_cents > 0`. | ✅ `price.test.ts` |
| Price without any currency anywhere in the sheet | Blocking "No currency for price". | 🟡 |
| Bare number (`12.50`) in a multi-currency sheet | Takes the currency stated on the same product's other rows; if no row of that product states one and the sheet mixes currencies, the product is blocked for review instead of guessed. | ✅ `bun run eval` (currency 100 %) |
| Mixed units: `2 lb 4 oz`, `1,2 kg`, `300 mm`, `12 x 8 in`, `Ø 25 cm` | Converted to integer grams / cm (0.1 cm), compound values summed; header hints like `Weight (kg)` apply to bare numbers. Bare number with no unit anywhere → flagged, not guessed. | ✅ `units-encoding.test.ts` |
| Implausible weight (e.g. 250 kg for a mug) | Blocking "Weight … looks implausible" → Needs review. | ✅ `claims.test.ts` (assemble) |
| Colour typos (`terracota`, `blakc`) | Matched to a known list with Damerau distance scaled to word length; every correction stored with row+column. Ambiguous ties are **not** corrected. Unknown colours are kept as-is and flagged (non-blocking). | ✅ `colour-html-language.test.ts` |
| German/French colour & size words (`Anthrazit`, `groß`, `taille unique`) | Normalised to canonical English values; the supplier wording is kept for provenance. | ✅ |
| Duplicate SKU, identical rows | Merged into one variant, recorded as "duplicate of row N". | ✅ `grouping.test.ts` |
| Duplicate SKU, conflicting rows (different price/weight) | Kept once, **blocking conflict** naming both rows and values → Needs review, routed to the stronger model. | ✅ `grouping.test.ts` |
| Same SKU with different punctuation (`TP1001-RED-L` vs `TP-1001-RED-L`) | Treated as the same variant, correction recorded. | ✅ `grouping.test.ts` |
| Variant rows split up / out of order / no parent column | Grouped by parent → handle → SKU base (stripping colour/size/abbreviation suffixes like `-TER`, `-50X50C`) → sibling-SKU rule → title. Verified on the 10k fixture against ground truth: **0 mixed groups, 0 split products**. | ✅ `grouping.test.ts` + fixture measurement |
| Two different SKUs, same/near-same title | Not merged (could be legit). Both flagged "Possible duplicate of product with rows …". | ✅ `grouping.test.ts` |
| Missing SKU | Placeholder `CF-xxxxxxxx` generated so the product can be reviewed; blocking "SKU is missing". | 🟡 |
| Missing title | Non-blocking issue; the model writes a title from the rest, confidence reflects it. | 🟡 |
| Completely empty rows in the middle | Kept (row numbers stay true) and end as **Failed** "Row has no SKU, parent, handle or title". Counts still add up. | ✅ fixture has them; `import.test.ts` reconciles |
| Huge descriptions | Sanitised; only the first 1,000 chars go into the prompt facts; model output capped by schema (10,000 chars). | 🟡 |
| HTML with `<script>`, `onclick`, `style`, iframes, `javascript:` | `sanitize-html` allowlist (p, ul, li, strong, em, h3/h4, table…), no attributes at all; removed parts recorded. Model output is sanitised again before storage and again on manual edits. | ✅ `colour-html-language.test.ts`, `claims.test.ts` |
| Prompt injection inside supplier text ("ignore previous instructions…") | System prompt says supplier data is data; more importantly, any claim the model makes must quote the source **and** survive the claim checker, so injected "frost-proof" cannot reach the catalog. | 🟡 (fixture contains it; verifier tests cover the outcome) |
| Photos with no matching row | Stored, shown as unmatched in stats; never attached by guess. Fuzzy matching only tolerates letter typos; **different digits never match** (`TP-1002` ≠ `TP-1001`). | ✅ `grouping.test.ts` |
| Same photo name twice in one import | Unique per import (`import_id, file_name`); duplicate ignored. | 🟡 |
| Unknown extra columns (e.g. "Glaze Type") | Kept as attributes the model may use and claims may cite. | ✅ `grouping.test.ts` |

## 2. AI problems

| What happens | What the app does | Status |
|---|---|---|
| Model invents a claim ("dishwasher-safe" with no source) | Every claim must name `row N, column C` **and** a verbatim quote. The checker verifies the cell exists, the quote is in it, and every strong term in the claim appears in the quote with the same polarity. Failures are dropped, shown struck-through with the reason, and the product goes to review. | ✅ `claims.test.ts`, `import.test.ts` (mock injects ~4% fake claims) |
| Model overstates nuance ("frost-proof" when source says "frost-resistant, not frost-proof") | Negation-aware check rejects it. | ✅ `claims.test.ts`, `import.test.ts` |
| Model smuggles a claim into the description instead of `claims` | Generated title/description/tags/attributes are scanned; any strong term not backed by a verified claim or un-negated source text → Needs review "Copy says X but no source row supports it". | ✅ `claims.test.ts` |
| Category not in the taxonomy | Exact/near match accepted (near match caps confidence at 75); otherwise Needs review. | ✅ `claims.test.ts` |
| Invalid JSON / schema mismatch / missing product in the answer | zod validation; retried with backoff and the validation error fed back as a repair hint; if a chunk keeps failing it is **split in halves** to isolate the bad product; a single product that still fails → Failed with the reason. | ✅ `faults.test.ts`, `translation-ai.test.ts` |
| Timeouts, 5xx, overloaded | Retried inline (3 attempts, exponential backoff + jitter), then the job is retried by pg-boss (6 retries, exponential backoff). After 6 build attempts a product is marked Failed with the last error. | ✅ `faults.test.ts`, `translation-ai.test.ts` |
| Rate limit (429) | The import is **paused** with `paused_until` from `retry-after`; jobs re-schedule themselves for that time; the UI shows "Paused, resuming in N minutes". No retries burn quota while paused. | ✅ `rate-limit.test.ts` |
| Provider down for a long time | Products keep retrying until `MAX_BUILD_ATTEMPTS`, then Failed with reason; "Retry failed" requeues them. | 🟡 |
| Model refuses / truncated at max_tokens | Treated as invalid output → retry → split → Failed with reason. | 🟡 |
| Low confidence field | Any field < 70 → Needs review "Low confidence: attributes.care (64)". Colour-coded in the UI. | ✅ `claims.test.ts` |
| Batch API: some requests error or expire | Those products fall back to the synchronous path (with its retries and splitting). | 🟡 |
| Crash between creating a provider batch and saving its id | The batch row is written *before* submission; a row stuck in `submitting` is marked failed by the sweeper and the products are re-sent. Worst case: one duplicate provider batch is **paid for** (results are still applied once). | 🟡 (documented trade-off) |
| Translation breaks tags / `{{placeholders}}` / numbers / brand | Verified after every call; broken items retried with the specific problem as a hint; still broken → stored as `failed`, storefront shows English. | ✅ `translation-ai.test.ts` |

## 3. Scale

| What happens | What the app does | Status |
|---|---|---|
| 10,000-row import | Upload returns 202 in ~70 ms; everything runs in pg-boss jobs; uses the Batches API above 100 products. Measured in README. | ✅ `scripts/scale-run.ts` |
| Same file uploaded twice | Products are upserted by stable key; unchanged products (same content hash) keep their result and **make no AI call**. A double-click while the first is still running returns the running import. | ✅ `import.test.ts` |
| One row changed in a re-upload | Only that product is rebuilt (1 AI call); price updated. | ✅ `import.test.ts` |
| Re-upload with rows re-ordered | Content hash ignores row order → no rebuild; claim sources are re-pointed at the new row numbers. | ✅ `grouping.test.ts` (hash) |
| Two imports at once (incl. overlapping products) | Independent jobs; products upsert by key; a product built by one import is just synced into the other's rows; the sweeper reconciles rows from either import. | 🟡 (seen in the 5k+10k scale run, not a dedicated test) |
| Server/worker killed mid-import (kill -9) | Jobs heartbeat every 5 s; a dead worker's jobs are retried after ~10–20 s; every handler is idempotent (ON CONFLICT, built-hash checks, per-request `applied` flags). A sweeper re-enqueues anything left without a live job. | ✅ `crash-resume.test.ts` (killed twice) |
| Crash between a DB commit and enqueuing the next job | Sweeper finds pending rows with no live job and re-enqueues. | ✅ covered by `crash-resume.test.ts` |
| Counts must add up | Every row ends Done / Needs review / Failed; a DB **trigger refuses** `status = completed` unless stored rows = sheet rows and none are pending; completed rows can't go back to pending. | ✅ all integration tests call `reconcile()` |
| Storefront under load during a 10k import | Storefront reads only the published snapshot through `use cache` functions; data is warmed on publish; 4 web processes with LISTEN/NOTIFY invalidation. p95 63–72 ms at 50 req/s during the import (README). | ✅ k6 |
| Shopper hits a process whose cache is stale after an approve or edit | Writers NOTIFY; every process bumps the product's cache-key version. Checked by hand: 16/16 requests showed the edit immediately. | 🟡 (manual check) |

## 4. Later changes

| What happens | What the app does | Status |
|---|---|---|
| Merchant edits title/description/category/tags/attributes | Edited fields are remembered; later AI rebuilds never overwrite them. English change → translation job. Published products are re-snapshotted and their cache tags expired. | 🟡 |
| Merchant fixes a translation | Stored as `manual` with the hash of the English it was written against; machine translations never overwrite it. | ✅ `translation-ai.test.ts` (plan) |
| English changes after a manual translation | Manual text kept, marked **Out of date**, counted on Metrics, filterable on Products. If the English is changed back, it becomes manual again. | ✅ `translation-ai.test.ts` |
| Only one field of English changes | Per-field source hashes: only that field is re-translated; identical text anywhere is served from the translation cache. | ✅ (plan) / 🟡 cache |
| Merchant "sends back" a product with a note | Unpublished, rebuilt with the note in the prompt; manual edits kept. | 🟡 |
| Merchant deletes a product | Unpublished and soft-deleted; the stable key stays as a tombstone, so re-uploading the same sheet doesn't recreate it. Its rows end as Failed ("deleted by the merchant"), and counts still add up. | ✅ `import.test.ts` |
| SKU moves to a different product in a later sheet | Not reassigned silently: product → Needs review "SKU X already belongs to product Y". | 🟡 |

## 5. Storefront

| What happens | What the app does | Status |
|---|---|---|
| Product still under review | Not visible: only approved products are snapshotted into `storefront_products`. | ✅ (approve requires price on every variant) |
| Product edited after publishing | Snapshot refreshed, cache tags expired. | 🟡 |
| Missing or failed translation | Falls back to English for that field. | 🟡 |
| Visitor from a country with no translation (e.g. NL, CH-fr) | English, by design of the country map (DE, AT, CH-de → German; FR, BE-fr → French; everyone else English). | ✅ `translation-ai.test.ts` |
| Unknown handle / collection | Friendly "not available" page in the visitor's language. | 🟡 |
| Storefront calls the AI | Impossible by construction: storefront code only imports the snapshot reader. | ✅ (code structure) |

## Not handled yet (and what I'd do)

- **Multiple stores / auth**: single merchant. All tables would get a `store_id`, enforced by RLS.
- **Image analysis beyond the model**: no Sharp resizing; photos over 3.75 MB are not sent to the vision model (still shown). I'd resize with Sharp before sending.
- **Units for volume (ml, l)**: kept as text, not normalised.
- **Duplicate provider batch after a crash during submission**: costs money, not correctness (see above).
