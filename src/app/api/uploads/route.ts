import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { handleError } from "@/lib/api";
import { LIMITS } from "@/lib/imports";

/**
 * Issues short-lived tokens so the browser uploads sheets and photo ZIPs straight to private Blob
 * storage (Vercel caps function request bodies at 4.5 MB). Behind ADMIN_PASSWORD like the rest of
 * the API; the import itself is then started with POST /api/imports and the uploaded paths.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as HandleUploadBody;
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith("uploads/")) throw new Error("Uploads go under uploads/");
        return { addRandomSuffix: true, maximumSizeInBytes: LIMITS.zipBytes };
      },
    });
    return NextResponse.json(result);
  } catch (err) {
    return handleError(err);
  }
}
