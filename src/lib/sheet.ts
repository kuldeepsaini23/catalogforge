import { unzipSync } from "fflate";
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
/** An XLSX is a ZIP of XML; refuse one that would expand past this before parsing it. */
const MAX_XLSX_EXPANDED_BYTES = 400 * 1024 * 1024;

function checkXlsxExpansion(bytes: Uint8Array, fileName: string): void {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return; // legacy .xls (not a ZIP)
  let total = 0;
  try {
    unzipSync(bytes, {
      filter: (f) => {
        total += f.originalSize;
        return false;
      },
    });
  } catch {
    throw new SheetError(`Could not read ${fileName}: the file is corrupt`);
  }
  if (total > MAX_XLSX_EXPANDED_BYTES) throw new SheetError(`${fileName} expands to ${Math.round(total / 1024 / 1024)} MB of data; the limit is ${MAX_XLSX_EXPANDED_BYTES / 1024 / 1024} MB`);
}

export function parseSheet(bytes: Uint8Array, fileName: string): ParsedSheet {
  const isCsv = /\.(csv|tsv|txt)$/i.test(fileName);
  let wb: XLSX.WorkBook;
  try {
    if (isCsv) {
      const text = decodeCsv(bytes);
      // sheetRows: stop parsing just past the limit (header + MAX_ROWS + 1 shows it was exceeded).
      wb = XLSX.read(text, { type: "string", raw: true, FS: sniffDelimiter(text), dense: true, sheetRows: MAX_ROWS + 2 });
    } else {
      checkXlsxExpansion(bytes, fileName);
      wb = XLSX.read(bytes, { type: "array", dense: true, cellDates: false, sheetRows: MAX_ROWS + 2 });
    }
  } catch (err) {
    if (err instanceof SheetError) throw err;
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
    throw new SheetError(`The sheet has more than ${MAX_ROWS.toLocaleString("en")} rows, which is the limit`);
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
