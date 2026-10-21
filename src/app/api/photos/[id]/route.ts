import { eq } from "drizzle-orm";
import { connection, NextResponse } from "next/server";
import { z } from "zod";
import { getDb, schema } from "@/lib/db/client";
import { readStoredFile } from "@/lib/storage";

export async function GET(_req: Request, ctx: RouteContext<"/api/photos/[id]">) {
  await connection();
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: "Photo not found" }, { status: 404 });
  const photo = await getDb().query.photos.findFirst({ where: eq(schema.photos.id, id) });
  if (!photo) return NextResponse.json({ error: "Photo not found" }, { status: 404 });
  const data = await readStoredFile(photo.path);
  return new NextResponse(new Uint8Array(data), {
    headers: { "Content-Type": photo.mediaType, "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
