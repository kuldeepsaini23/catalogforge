import { connection, NextResponse } from "next/server";
import { handleError } from "@/lib/api";
import { getMetrics } from "@/lib/metrics";

export async function GET() {
  await connection();
  try {
    return NextResponse.json(await getMetrics());
  } catch (err) {
    return handleError(err);
  }
}
