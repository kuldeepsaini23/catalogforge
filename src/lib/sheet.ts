import * as XLSX from "xlsx";
import { normalizeWhitespace } from "@/lib/cleaning/text";

export const MAX_ROWS = 10_000;

export interface ParsedSheet {
  headers: string[];
  rows: Array<Record<string, string>>;
}

export class SheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetError";
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const cp1252 = new TextDecoder("windows-1252");

/** Decodes CSV bytes: UTF-8 (with or without BOM), falling back to Windows-1252. */
export function decodeCsv(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes).replace(/^﻿/, "");
  } catch {
    return cp1252.decode(bytes);
  }
}

function sniffDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n/) === -1 ? text.length : text.search(/\r?\n/));
  const counts: Array<[string, number]> = [",", ";", "\t", "|"].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

/**
 * Parses CSV or XLSX into string cells. Values stay as the supplier wrote them ("1.299,00 €" is not
 * coerced to a number), and blank rows are kept so sheet row numbers stay accurate.
 */
export function parseSheet(bytes: Uint8Array, fileName: string): ParsedSheet {
  const isCsv = /\.(csv|tsv|txt)$/i.test(fileName);
  let wb: XLSX.WorkBook;
  try {
    if (isCsv) {
      const text = decodeCsv(bytes);
      wb = XLSX.read(text, { type: "string", raw: true, FS: sniffDelimiter(text), dense: true });
    } else {
      wb = XLSX.read(bytes, { type: "array", dense: true, cellDates: false });
    }
  } catch (err) {
    throw new SheetError(`Could not read ${fileName}: ${(err as Error).message}`);
  }
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new SheetError("The workbook has no sheets");
  const matrix = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[sheetName], {
    header: 1,
    raw: false,
    defval: "",
    blankrows: true,
  });
  // Drop trailing blank rows only (interior blank rows keep their row numbers and fail as empty).
  while (matrix.length && matrix[matrix.length - 1].every((c) => !String(c ?? "").trim())) matrix.pop();
  if (matrix.length === 0) throw new SheetError("The sheet is empty");

  const seen = new Map<string, number>();
  const headers = matrix[0].map((h, i) => {
    const base = normalizeWhitespace(String(h ?? "")) || `Column ${i + 1}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base} (${n + 1})` : base;
  });
  const dataRows = matrix.slice(1);
  if (dataRows.length > MAX_ROWS) {
    throw new SheetError(`The sheet has ${dataRows.length.toLocaleString("en")} rows; the limit is ${MAX_ROWS.toLocaleString("en")}`);
  }
  if (dataRows.length === 0) throw new SheetError("The sheet has a header row but no data rows");
  const rows = dataRows.map((cells) => {
    const r: Record<string, string> = {};
    headers.forEach((h, i) => {
      r[h] = String(cells[i] ?? "");
    });
    return r;
  });
  return { headers, rows };
}
