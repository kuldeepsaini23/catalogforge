import path from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { unzipSync } from "fflate";
import { PHOTO_EXTENSIONS } from "@/lib/cleaning/photos";
import { getDb, schema } from "@/lib/db/client";
import { MAX_PHOTOS } from "@/lib/pipeline/ingest";
import { QUEUES, send } from "@/lib/queue";
import { safeFileName, saveFile, sha256Bytes } from "@/lib/storage";

export const LIMITS = {
  sheetBytes: 25 * 1024 * 1024,
  photoBytes: 15 * 1024 * 1024,
  zipBytes: 500 * 1024 * 1024,
  photos: MAX_PHOTOS,
};
const SHEET_EXT = /\.(csv|tsv|txt|xlsx|xls)$/i;

export class UploadError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "UploadError";
  }
}

export interface UploadFile {
  name: string;
  bytes: Uint8Array;
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/** Counts images inside a ZIP from its directory only (no decompression). */
function zipImageCount(bytes: Uint8Array): number {
  let n = 0;
  try {
    unzipSync(bytes, {
      filter: (f) => {
        if (PHOTO_EXTENSIONS.test(f.name) && !f.name.startsWith("__MACOSX/")) {
          n++;
          if (f.originalSize > LIMITS.photoBytes) throw new UploadError(`${f.name} in the ZIP is larger than ${mb(LIMITS.photoBytes)}`);
        }
        return false;
      },
    });
  } catch (err) {
    if (err instanceof UploadError) throw err;
    throw new UploadError("The ZIP file is corrupt or not a ZIP");
  }
  return n;
}

export function validateUpload(sheet: UploadFile | null, photos: UploadFile[]): void {
  if (!sheet) throw new UploadError("Add a CSV or XLSX supplier sheet");
  if (!SHEET_EXT.test(sheet.name)) throw new UploadError(`"${sheet.name}" is not a CSV or XLSX file`);
  if (sheet.bytes.byteLength === 0) throw new UploadError(`"${sheet.name}" is empty`);
  if (sheet.bytes.byteLength > LIMITS.sheetBytes) throw new UploadError(`"${sheet.name}" is ${mb(sheet.bytes.byteLength)}; the limit is ${mb(LIMITS.sheetBytes)}`);
  let count = 0;
  for (const p of photos) {
    if (/\.zip$/i.test(p.name)) {
      if (p.bytes.byteLength > LIMITS.zipBytes) throw new UploadError(`"${p.name}" is larger than ${mb(LIMITS.zipBytes)}`);
      count += zipImageCount(p.bytes);
    } else if (PHOTO_EXTENSIONS.test(p.name)) {
      if (p.bytes.byteLength > LIMITS.photoBytes) throw new UploadError(`"${p.name}" is larger than ${mb(LIMITS.photoBytes)}`);
      count++;
    } else {
      throw new UploadError(`"${p.name}" is not a supported photo (JPG, PNG, WebP, GIF, AVIF) or ZIP`);
    }
  }
  if (count > LIMITS.photos) throw new UploadError(`${count} photos uploaded; the limit is ${LIMITS.photos.toLocaleString("en")}`);
}

/**
 * Stores the upload and enqueues ingestion; returns immediately. A double-submit of the same file
 * while it is still processing returns the running import instead of starting a second one.
 */
export async function createImport(sheet: UploadFile, photos: UploadFile[]): Promise<{ id: string; deduplicated: boolean }> {
  validateUpload(sheet, photos);
  const db = getDb();
  const fileHash = sha256Bytes(sheet.bytes);
  const running = await db
    .select({ id: schema.imports.id })
    .from(schema.imports)
    .where(and(eq(schema.imports.fileHash, fileHash), inArray(schema.imports.status, ["queued", "parsing", "building", "paused"])))
    .orderBy(desc(schema.imports.createdAt))
    .limit(1);
  if (running[0]) return { id: running[0].id, deduplicated: true };

  const id = crypto.randomUUID();
  const dir = path.join("imports", id, "upload");
  const sheetPath = await saveFile(path.join(dir, safeFileName(sheet.name)), sheet.bytes);
  const photoPaths: string[] = [];
  for (const p of photos) photoPaths.push(await saveFile(path.join(dir, safeFileName(p.name)), p.bytes));
  await db.insert(schema.imports).values({ id, fileName: safeFileName(sheet.name), fileHash, sheetPath, photoPaths, photoCount: 0, phase: "Queued" });
  await send(QUEUES.ingest, { importId: id }, { singletonKey: `ingest:${id}` });
  return { id, deduplicated: false };
}
