import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { get, put } from "@vercel/blob";
import { unzipSync } from "fflate";
import { env } from "@/lib/env";

/**
 * Uploaded files live on local disk (STORAGE_DIR) or, when BLOB_READ_WRITE_TOKEN is set (Vercel,
 * where functions share no disk), in a private Vercel Blob store under the same relative paths.
 */
export function usesBlobStorage(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/** Absolute path inside STORAGE_DIR; rejects traversal outside it. */
export function resolveStoragePath(relative: string): string {
  const root = path.resolve(env().STORAGE_DIR);
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`Path escapes storage: ${relative}`);
  return full;
}

function blobPath(relative: string): string {
  const p = relative.replace(/\\/g, "/");
  if (p.split("/").some((s) => s === ".." || s === "")) throw new Error(`Invalid storage path: ${relative}`);
  return p;
}

export async function saveFile(relative: string, data: Uint8Array): Promise<string> {
  if (usesBlobStorage()) {
    await put(blobPath(relative), Buffer.from(data), { access: "private", addRandomSuffix: false, allowOverwrite: true });
    return blobPath(relative);
  }
  const full = resolveStoragePath(relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, data);
  return relative.replace(/\\/g, "/");
}

async function readWhole(relative: string): Promise<Uint8Array> {
  if (!usesBlobStorage()) return new Uint8Array(await readFile(resolveStoragePath(relative)));
  const res = await get(blobPath(relative), { access: "private" });
  if (!res || res.statusCode !== 200) throw new Error(`Stored file not found: ${relative}`);
  return new Uint8Array(await new Response(res.stream).arrayBuffer());
}

/**
 * A photo inside an uploaded ZIP is referenced as "<zip path>#<entry name>" (Blob storage keeps
 * the ZIP whole instead of paying one write per photo). Recently read ZIPs are kept in memory.
 */
export function zipEntryRef(zipPath: string, entry: string): string {
  return `${zipPath}#${entry}`;
}

const zipCache = new Map<string, Uint8Array>();
const ZIP_CACHE_BYTES = 300 * 1024 * 1024;

async function readZip(zipPath: string): Promise<Uint8Array> {
  const hit = zipCache.get(zipPath);
  if (hit) return hit;
  const data = await readWhole(zipPath);
  let total = data.byteLength;
  for (const v of zipCache.values()) total += v.byteLength;
  for (const k of zipCache.keys()) {
    if (total <= ZIP_CACHE_BYTES) break;
    total -= zipCache.get(k)!.byteLength;
    zipCache.delete(k);
  }
  if (data.byteLength <= ZIP_CACHE_BYTES) zipCache.set(zipPath, data);
  return data;
}

export async function readStoredFile(ref: string): Promise<Uint8Array> {
  const hash = ref.indexOf("#");
  if (hash === -1) return readWhole(ref);
  const zipPath = ref.slice(0, hash);
  const entry = ref.slice(hash + 1);
  const data = unzipSync(await readZip(zipPath), { filter: (f) => f.name === entry })[entry];
  if (!data) throw new Error(`Photo ${entry} not found in ${zipPath}`);
  return data;
}

export function sha256Bytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** File names from users/ZIPs are reduced to a safe basename. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[^\w.\- ()]+/g, "_").slice(0, 160) || "file";
}
