import { mapHeaders } from "./columns";
import { groupRows } from "./group";
import { cleanRow, inferDefaultCurrency, type RawRow } from "./row";

export * from "./colour";
export * from "./columns";
export * from "./encoding";
export * from "./group";
export * from "./html";
export * from "./language";
export * from "./photos";
export * from "./price";
export * from "./row";
export * from "./text";
export * from "./types";
export * from "./units";

/** Sheet row number of the first data row (row 1 is the header). */
export const FIRST_DATA_ROW = 2;

/** Pure end-to-end cleaning of a parsed sheet: headers + raw rows → cleaned rows + product groups. */
export function cleanSheet(headers: string[], rawRows: RawRow[]) {
  const mapping = mapHeaders(headers);
  const defaultCurrency = inferDefaultCurrency(rawRows, mapping);
  const rows = rawRows.map((r, i) => cleanRow(r, i + FIRST_DATA_ROW, { mapping, defaultCurrency }));
  const { groups, orphanRows } = groupRows(rows);
  return { mapping, defaultCurrency, rows, groups, orphanRows };
}
