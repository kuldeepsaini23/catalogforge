import type { RouteOverride } from "./build";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { unzipSync } from "fflate";
import { cleanSheet, groupContentHash, matchPhotos, PHOTO_EXTENSIONS, type ProductGroup } from "@/lib/cleaning";
import { sha256 } from "@/lib/cleaning/text";
import { routeProduct } from "@/lib/ai/routing";
import { getDb, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { send, QUEUES } from "@/lib/queue";
import { parseSheet, SheetError } from "@/lib/sheet";
import { resolveStoragePath, safeFileName, saveFile, sha256Bytes } from "@/lib/storage";
import type { ImportStats } from "@/lib/db/schema";
import { toProductInput, type InputPhoto } from "./input";
import { syncRowStatuses } from "./rows";
import { maybeFinalize } from "./finalize";

export const MAX_PHOTOS = 2_000;
const MEDIA_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif",
};

function mediaTypeOf(name: string): string {
  return MEDIA_TYPES[name.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
}

/** Extracts uploaded photos (single files or ZIPs) into storage and records them. Idempotent. */
async function ingestPhotos(importId: string, photoPaths: string[]): Promise<void> {
  const db = getDb();
  const records: Array<typeof schema.photos.$inferInsert> = [];
  const add = async (fileName: string, data: Uint8Array) => {
    const safe = safeFileName(fileName);
    const rel = await saveFile(path.join("imports", importId, "photos", safe), data);
    records.push({
      importId,
      fileName: safe,
      path: rel,
      sizeBytes: data.byteLength,
      sha256: sha256Bytes(data),
      mediaType: mediaTypeOf(safe),
      matchMethod: "none",
      matchScore: 0,
    });
  };
  for (const p of photoPaths) {
    const data = new Uint8Array(await readFile(resolveStoragePath(p)));
    if (/\.zip$/i.test(p)) {
      // Inflate one entry at a time so memory stays at one photo, not the whole archive.
      const names: string[] = [];
      unzipSync(data, {
        filter: (f) => {
          if (PHOTO_EXTENSIONS.test(f.name) && !f.name.startsWith("__MACOSX/") && !/(^|\/)\./.test(f.name)) names.push(f.name);
          return false;
        },
      });
      if (names.length > MAX_PHOTOS) throw new SheetError(`${names.length} photos uploaded; the limit is ${MAX_PHOTOS}`);
      for (const name of names) {
        const entry = unzipSync(data, { filter: (f) => f.name === name })[name];
        if (entry) await add(name, entry);
      }
    } else {
      await add(path.basename(p), data);
    }
  }
  if (records.length > MAX_PHOTOS) throw new SheetError(`${records.length} photos uploaded; the limit is ${MAX_PHOTOS}`);
  for (let i = 0; i < records.length; i += 500) {
    await db.insert(schema.photos).values(records.slice(i, i + 500)).onConflictDoNothing();
  }
}

/**
 * import.ingest: parse → clean → store rows → group → upsert products → enqueue AI work.
 * Every write is an upsert or ON CONFLICT DO NOTHING, so re-running after a crash is harmless.
 */
export async function handleIngest(importId: string): Promise<void> {
  const db = getDb();
  const imp = await db.query.imports.findFirst({ where: eq(schema.imports.id, importId) });
  if (!imp || imp.status === "completed" || imp.status === "failed") return;
  await db
    .update(schema.imports)
    .set({ status: "parsing", phase: "Parsing sheet", startedAt: imp.startedAt ?? new Date(), updatedAt: new Date() })
    .where(eq(schema.imports.id, importId));

  let parsed;
  try {
    parsed = parseSheet(new Uint8Array(await readFile(resolveStoragePath(imp.sheetPath))), imp.fileName);
    await ingestPhotos(importId, imp.photoPaths);
  } catch (err) {
    if (err instanceof SheetError) {
      await db.update(schema.imports).set({ status: "failed", error: err.message, phase: null, finishedAt: new Date(), updatedAt: new Date() }).where(eq(schema.imports.id, importId));
      if (env().IMPORT_WEBHOOK_URL) await send(QUEUES.webhook, { importId, event: "import.failed" });
      return;
    }
    throw err;
  }

  await db.update(schema.imports).set({ totalRows: parsed.rows.length, phase: "Cleaning rows", updatedAt: new Date() }).where(eq(schema.imports.id, importId));
  const cleaned = cleanSheet(parsed.headers, parsed.rows);

  // 1. Source rows (raw + cleaned + provenance).
  for (let i = 0; i < cleaned.rows.length; i += 500) {
    const chunk = cleaned.rows.slice(i, i + 500);
    await db
      .insert(schema.sourceRows)
      .values(
        chunk.map((r) => ({
          importId,
          rowNumber: r.row,
          rowKey: r.rowKey,
          raw: parsed.rows[r.row - 2],
          cleaned: r,
          language: r.language,
        })),
      )
      .onConflictDoNothing();
  }

  // 2. Photos ↔ products.
  const photoRows = await db.select().from(schema.photos).where(eq(schema.photos.importId, importId));
  const matches = matchPhotos(photoRows.map((p) => p.fileName), cleaned.groups);
  const photosByGroup = new Map<string, InputPhoto[]>();
  const photoHashesByGroup = new Map<string, string[]>();
  matches.forEach((m, i) => {
    if (!m.groupKey) return;
    const p = photoRows[i];
    if (!photosByGroup.has(m.groupKey)) photosByGroup.set(m.groupKey, []);
    photosByGroup.get(m.groupKey)!.push({ id: p.id, fileName: p.fileName, path: p.path, mediaType: p.mediaType });
    if (!photoHashesByGroup.has(m.groupKey)) photoHashesByGroup.set(m.groupKey, []);
    photoHashesByGroup.get(m.groupKey)!.push(p.sha256);
  });

  // 3. Products: upsert by stable key; an unchanged product keeps its built result.
  await db.update(schema.imports).set({ phase: "Grouping products", updatedAt: new Date() }).where(eq(schema.imports.id, importId));
  const productIdByKey = new Map<string, string>();
  const pendingIds: string[] = [];
  const unchangedIds: string[] = [];
  const groupByKey = new Map<string, ProductGroup>(cleaned.groups.map((g) => [g.key, g]));
  for (let i = 0; i < cleaned.groups.length; i += 200) {
    const chunk = cleaned.groups.slice(i, i + 200);
    const values = chunk.map((g) => {
      const contentHash = groupContentHash(g, photoHashesByGroup.get(g.key));
      return {
        stableKey: g.key,
        handle: `pending-${sha256(g.key).slice(0, 16)}`,
        status: "pending" as const,
        contentHash,
        input: toProductInput(g, photosByGroup.get(g.key) ?? []),
        lastImportId: importId,
        issues: g.issues,
        corrections: g.corrections,
        sourceRows: g.rows.map((r) => r.row),
      };
    });
    const res = await db
      .insert(schema.products)
      .values(values)
      .onConflictDoUpdate({
        target: schema.products.stableKey,
        set: {
          contentHash: sql`excluded.content_hash`,
          input: sql`excluded.input`,
          lastImportId: sql`excluded.last_import_id`,
          issues: sql`excluded.issues`,
          corrections: sql`excluded.corrections`,
          sourceRows: sql`excluded.source_rows`,
          // Changed content → rebuild; unchanged → keep status (incl. approved) and AI result.
          // Deleted products stay deleted (tombstone): their rows end as Failed with a reason.
          status: sql`CASE WHEN ${schema.products.deletedAt} IS NOT NULL OR ${schema.products.builtHash} = excluded.content_hash THEN ${schema.products.status} ELSE 'pending'::product_status END`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: schema.products.id, key: schema.products.stableKey, status: schema.products.status, builtHash: schema.products.builtHash, contentHash: schema.products.contentHash, deletedAt: schema.products.deletedAt });
    for (const r of res) {
      productIdByKey.set(r.key, r.id);
      if (r.status === "pending" && !r.deletedAt) pendingIds.push(r.id);
      else unchangedIds.push(r.id);
    }
  }

  // Claims cite row numbers; for unchanged products re-point provenance at this upload's rows.
  if (unchangedIds.length) {
    for (const id of unchangedIds) {
      const p = await db.query.products.findFirst({ where: eq(schema.products.id, id), columns: { stableKey: true, claims: true } });
      const g = p && groupByKey.get(p.stableKey);
      if (!p || !g) continue;
      await db.update(schema.products).set({ claims: remapClaims(p.claims, g) }).where(eq(schema.products.id, id));
    }
  }

  // 4. Link rows to products; photos to products.
  const links = cleaned.groups.flatMap((g) => g.rows.map((r) => [r.row, productIdByKey.get(g.key)!] as const));
  for (let i = 0; i < links.length; i += 1000) {
    const chunk = links.slice(i, i + 1000);
    await db.execute(sql`
      UPDATE source_rows r SET product_id = v.pid::uuid
      FROM (VALUES ${sql.join(chunk.map(([row, pid]) => sql`(${row}::int, ${pid})`), sql`, `)}) AS v(row_number, pid)
      WHERE r.import_id = ${importId} AND r.row_number = v.row_number AND r.product_id IS DISTINCT FROM v.pid::uuid
    `);
  }
  for (const [i, m] of matches.entries()) {
    if (!m.groupKey) continue;
    await db
      .update(schema.photos)
      .set({ productId: productIdByKey.get(m.groupKey), sku: m.sku, matchMethod: m.method, matchScore: m.score })
      .where(eq(schema.photos.id, photoRows[i].id));
  }
  for (const orphan of cleaned.orphanRows) {
    await db
      .update(schema.sourceRows)
      .set({ status: "failed", statusReason: orphan.issues[0]?.message ?? "Empty row", updatedAt: new Date() })
      .where(and(eq(schema.sourceRows.importId, importId), eq(schema.sourceRows.rowNumber, orphan.row), eq(schema.sourceRows.status, "pending")));
  }
  await syncRowStatuses(db, importId, unchangedIds);

  // 5. Stats + enqueue AI work.
  const stats: ImportStats = {
    corrections: {},
    languages: {},
    photosMatched: matches.filter((m) => m.groupKey).length,
    photosUnmatched: matches.filter((m) => !m.groupKey).length,
    groups: cleaned.groups.length,
    skippedUnchanged: unchangedIds.length,
    orphanRows: cleaned.orphanRows.length,
  };
  for (const r of cleaned.rows) {
    stats.languages[r.language] = (stats.languages[r.language] ?? 0) + 1;
    for (const c of r.corrections) stats.corrections[c.kind] = (stats.corrections[c.kind] ?? 0) + 1;
  }
  for (const g of cleaned.groups) {
    for (const c of g.corrections) if (c.kind === "duplicate_merged" || c.kind === "sku_normalized") stats.corrections[c.kind] = (stats.corrections[c.kind] ?? 0) + 1;
  }

  const useBatch = env().AI_USE_BATCH && pendingIds.length >= env().AI_BATCH_THRESHOLD;
  await db
    .update(schema.imports)
    .set({
      status: "building",
      phase: pendingIds.length ? `Building ${pendingIds.length} products` : "Finalising",
      productsTotal: cleaned.groups.length,
      mode: useBatch ? "batch" : "sync",
      stats,
      updatedAt: new Date(),
    })
    .where(eq(schema.imports.id, importId));

  await enqueueBuilds(importId, pendingIds, useBatch);
  await maybeFinalize(importId);
}

function remapClaims(claims: Array<{ text: string; source: string; quote: string }>, g: ProductGroup) {
  return claims.map((c) => {
    const m = /^row (\d+), column (.+)$/.exec(c.source);
    if (!m) return c;
    // The product is unchanged, so a row with the same cell text exists; find it by quote.
    const row = g.rows.find((r) => (r.texts[m[2]] ?? "").includes(c.quote));
    return row ? { ...c, source: `row ${row.row}, column ${m[2]}` } : c;
  });
}

/** Routes pending products and enqueues build jobs (chunks per route) or one batch submission. */
export async function enqueueBuilds(importId: string, productIds: string[], useBatch: boolean, override?: RouteOverride): Promise<void> {
  if (!productIds.length) return;
  if (useBatch) {
    await send(QUEUES.batchSubmit, { importId }, { singletonKey: `batch-submit:${importId}` });
    return;
  }
  const db = getDb();
  const rows = await db
    .select({ id: schema.products.id, input: schema.products.input })
    .from(schema.products)
    .where(inArray(schema.products.id, productIds));
  const buckets: Record<string, string[]> = {};
  for (const r of rows) {
    const d = override ? { ...override, vision: override.vision && r.input!.photos.length > 0 } : routeProduct(r.input!);
    const key = `${d.route}:${d.vision}`;
    (buckets[key] ??= []).push(r.id);
  }
  for (const [key, ids] of Object.entries(buckets)) {
    const [route, vision] = key.split(":") as ["cheap" | "strong", string];
    const size = route === "cheap" ? env().AI_PRODUCTS_PER_CALL_CHEAP : env().AI_PRODUCTS_PER_CALL_STRONG;
    for (let i = 0; i < ids.length; i += size) {
      await send(QUEUES.build, { importId, productIds: ids.slice(i, i + size), route, vision: vision === "true" });
    }
  }
}

