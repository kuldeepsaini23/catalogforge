import { del } from "@vercel/blob";
import { after, connection, NextResponse } from "next/server";
import { z } from "zod";
import { handleError } from "@/lib/api";
import { createImport, LIMITS, UploadError, type UploadFile } from "@/lib/imports";
import { listImports } from "@/lib/queries";
import { readStoredFile } from "@/lib/storage";
import { kickWorker } from "@/lib/serverless-worker";

// Files already uploaded to Blob storage by the browser (see /api/uploads).
const storedSchema = z.object({
  sheet: z.object({ pathname: z.string(), name: z.string() }),
  photos: z.array(z.object({ pathname: z.string(), name: z.string() })).max(LIMITS.photos).default([]),
});

async function fromStorage(f: { pathname: string; name: string }): Promise<UploadFile> {
  if (!/^uploads\/[^#]+$/.test(f.pathname) || f.pathname.includes("..")) throw new UploadError("Invalid upload path");
  return { name: f.name, bytes: await readStoredFile(f.pathname) };
}

async function toUpload(v: FormDataEntryValue): Promise<UploadFile | null> {
  if (typeof v === "string") return null;
  return { name: v.name, bytes: new Uint8Array(await v.arrayBuffer()) };
}

/** Upload returns immediately (202); parsing, cleaning and AI work run in the background queue. */
export async function POST(request: Request) {
  try {
    if (request.headers.get("content-type")?.startsWith("application/json")) {
      const body = storedSchema.parse(await request.json());
      const result = await createImport(await fromStorage(body.sheet), await Promise.all(body.photos.map(fromStorage)));
      after(() => del([body.sheet, ...body.photos].map((f) => f.pathname)).catch(() => {}));
      after(() => kickWorker());
      return NextResponse.json(result, { status: 202 });
    }
    // Refuse oversized bodies before buffering them.
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > LIMITS.requestBytes) throw new UploadError(`The upload is larger than ${Math.round(LIMITS.requestBytes / 1024 / 1024)} MB`, 413);
    const form = await request.formData().catch(() => {
      throw new UploadError("Send the files as multipart/form-data");
    });
    const sheetEntry = form.get("sheet");
    const sheet = sheetEntry ? await toUpload(sheetEntry) : null;
    const photos = (await Promise.all(form.getAll("photos").map(toUpload))).filter((p): p is UploadFile => p !== null);
    if (!sheet) throw new UploadError("Add a CSV or XLSX supplier sheet");
    const result = await createImport(sheet, photos);
    after(() => kickWorker());
    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    return handleError(err);
  }
}

export async function GET() {
  await connection();
  try {
    return NextResponse.json({ imports: await listImports() });
  } catch (err) {
    return handleError(err);
  }
}
