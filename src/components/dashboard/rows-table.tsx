"use client";

import { useState } from "react";
import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { Pagination } from "./pagination";
import { StatusBadge } from "./status";
import { useJson } from "./use-json";

interface RowItem {
  rowNumber: number;
  status: string;
  statusReason: string | null;
  language: string;
  productId: string | null;
  sku: string | null;
  title: string | null;
  handle: string | null;
}

const FILTERS = [
  { value: "", label: "All" },
  { value: "pending", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "needs_review", label: "Needs review" },
  { value: "failed", label: "Failed" },
];

/** Per-row status for one import, with the reason for every row that needs review or failed. */
export function RowsTable({ importId, live }: { importId: string; live: boolean }) {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const { data, error } = useJson<{ items: RowItem[]; total: number }>(
    `/api/imports/${importId}/rows?status=${status}&page=${page}&size=${size}`,
    live ? 2000 : false,
  );
  return (
    <div>
      <div role="tablist" aria-label="Filter rows by status" className="flex gap-1 overflow-x-auto px-4 pt-3">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            role="tab"
            aria-selected={status === f.value}
            onClick={() => {
              setStatus(f.value);
              setPage(1);
            }}
            className={cn("rounded px-2.5 py-1 text-sm whitespace-nowrap text-slate hover:bg-secondary", status === f.value && "bg-secondary font-medium text-ink")}
          >
            {f.label}
          </button>
        ))}
      </div>
      {error && <p className="px-4 py-3 text-sm text-fail">{error}</p>}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16 pl-4">Row</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Title in sheet</TableHead>
              <TableHead className="w-14">Lang</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.items.map((r) => (
              <TableRow key={r.rowNumber}>
                <TableCell className="pl-4 tabular-nums text-slate">{r.rowNumber}</TableCell>
                <TableCell className="font-mono text-xs">{r.sku ?? "—"}</TableCell>
                <TableCell className="max-w-72 truncate">
                  {r.productId ? (
                    <Link href={`/products/${r.productId}`} className="hover:underline">
                      {r.title ?? r.handle ?? "Untitled"}
                    </Link>
                  ) : (
                    (r.title ?? <span className="text-slate">Empty row</span>)
                  )}
                </TableCell>
                <TableCell className="uppercase text-slate text-xs">{r.language === "unknown" ? "?" : r.language}</TableCell>
                <TableCell className="max-w-md">
                  <div className="flex items-start gap-2">
                    <StatusBadge status={r.status} />
                    {r.statusReason && <span className="line-clamp-2 text-xs text-slate" title={r.statusReason}>{r.statusReason}</span>}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {data && data.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-sm text-slate">
                  No rows with this status.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {data && <Pagination page={page} size={size} total={data.total} onPage={setPage} onSize={(s) => { setSize(s); setPage(1); }} />}
    </div>
  );
}
