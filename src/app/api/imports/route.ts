import { connection, NextResponse } from "next/server";
import { handleError } from "@/lib/api";
import { createImport, LIMITS, UploadError, type UploadFile } from "@/lib/imports";
import { listImports } from "@/lib/queries";

async function toUpload(v: FormDataEntryValue): Promise<UploadFile | null> {
  if (typeof v === "string") return null;
  return { name: v.name, bytes: new Uint8Array(await v.arrayBuffer()) };
}

/** Upload returns immediately (202); parsing, cleaning and AI work run in the background queue. */
export async function POST(request: Request) {
  try {
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
