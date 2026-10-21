import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { UploadError } from "@/lib/imports";

/** Uniform JSON errors: validation → 400 with the message, everything else → 500 without internals. */
export function handleError(err: unknown): NextResponse {
  if (err instanceof UploadError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof ZodError) {
    return NextResponse.json({ error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") }, { status: 400 });
  }
  if (err instanceof SyntaxError) return NextResponse.json({ error: "Request body is not valid JSON" }, { status: 400 });
  console.error(err);
  return NextResponse.json({ error: "Something went wrong on the server. Check the server logs." }, { status: 500 });
}

export function intParam(v: string | null, fallback: number, allowed?: readonly number[]): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return fallback;
  if (allowed && !allowed.includes(n)) return fallback;
  return n;
}
