/**
 * Repairs mojibake: UTF-8 bytes that were decoded as Windows-1252/Latin-1 (e.g. "GrÃ¼n" → "Grün",
 * "â‚¬" → "€"). Handles double-encoding by repeating until the text stops changing.
 */

// Windows-1252 code points for bytes 0x80–0x9F (Latin-1 leaves them as C1 controls).
const CP1252_TO_BYTE = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
]);

const CONTINUATION = "[\\u0080-\\u00BF\\u0152\\u0153\\u0160\\u0161\\u0178\\u017D\\u017E\\u0192\\u02C6\\u02DC\\u2013\\u2014\\u2018-\\u201E\\u2020-\\u2022\\u2026\\u2030\\u2039\\u203A\\u20AC\\u2122]";
// A UTF-8 lead byte (C2–F4) rendered as a Latin-1 char, followed by 1–3 continuation bytes.
const MOJIBAKE_RUN = new RegExp(`[\\u00C2-\\u00F4]${CONTINUATION}{1,3}`, "g");
const MOJIBAKE_TEST = new RegExp(`[\\u00C2-\\u00F4]${CONTINUATION}`);

const utf8 = new TextDecoder("utf-8", { fatal: true });

function toByte(ch: string): number | null {
  const code = ch.codePointAt(0)!;
  if (code <= 0xff) return code;
  return CP1252_TO_BYTE.get(code) ?? null;
}

function decodeRun(run: string): string | null {
  const bytes: number[] = [];
  for (const ch of run) {
    const b = toByte(ch);
    if (b === null) return null;
    bytes.push(b);
  }
  try {
    return utf8.decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

export function looksLikeMojibake(input: string): boolean {
  return MOJIBAKE_TEST.test(input);
}

export function fixEncoding(input: string): string {
  let current = input;
  for (let pass = 0; pass < 3 && looksLikeMojibake(current); pass++) {
    const next = current.replace(MOJIBAKE_RUN, (run) => {
      // Try the longest valid prefix: a lead byte only takes as many continuation bytes as it needs.
      for (let len = run.length; len >= 2; len--) {
        const decoded = decodeRun(run.slice(0, len));
        if (decoded !== null) return decoded + run.slice(len);
      }
      return run;
    });
    if (next === current) break;
    current = next;
  }
  // Stray replacement chars and zero-width junk from bad exports.
  return current.replace(/﻿/g, "").replace(/Â(?=[  ])/g, "");
}
