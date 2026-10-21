import { NextResponse } from "next/server";
import { handleError } from "@/lib/api";
import { warmStorefront } from "@/lib/storefront-warm";

/** Warms the storefront data cache for every published product (run after a deploy). */
export async function POST() {
  try {
    const started = Date.now();
    const r = await warmStorefront();
    return NextResponse.json({ ...r, ms: Date.now() - started });
  } catch (err) {
    return handleError(err);
  }
}
