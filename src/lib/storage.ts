import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

/** Absolute path inside STORAGE_DIR; rejects traversal outside it. */
export function resolveStoragePath(relative: string): string {
  const root = path.resolve(env().STORAGE_DIR);
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`Path escapes storage: ${relative}`);
  return full;
}

export async function saveFile(relative: string, data: Uint8Array): Promise<string> {
  const full = resolveStoragePath(relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, data);
  return relative.replace(/\\/g, "/");
}

export function sha256Bytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** File names from users/ZIPs are reduced to a safe basename. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[^\w.\- ()]+/g, "_").slice(0, 160) || "file";
}
