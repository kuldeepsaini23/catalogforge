import { connection, NextResponse } from "next/server";
import { handleError } from "@/lib/api";
import { categories } from "@/lib/queries";
import { TAXONOMY } from "@/lib/taxonomy";

/** Categories in use (for filters) and the full taxonomy (for editing). */
export async function GET() {
  await connection();
  try {
    return NextResponse.json({ used: await categories(), taxonomy: TAXONOMY });
  } catch (err) {
    return handleError(err);
  }
}
