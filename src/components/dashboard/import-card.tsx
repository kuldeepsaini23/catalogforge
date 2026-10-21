"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { ImportSummary } from "@/lib/queries";
import { duration, int, relativeTime, usd } from "@/lib/format";
import { RowStrip } from "./row-strip";
import { RowsTable } from "./rows-table";
import { StatusBadge } from "./status";
import { postJson, useJson } from "./use-json";

type Serialized<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };
export type ImportRow = Serialized<ImportSummary>;

interface Detail {
  strip: string;
  reconciliation: { ok: boolean; total: number; sheetRows: number | null; problems: string[] };
}

const ACTIVE = new Set(["queued", "parsing", "building", "paused"]);

/** Current time, ticking every second while `live` (keeps render pure). */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);
  return now;
}

function countdown(until: string | null, now: number): string | null {
  if (!until) return null;
  const ms = new Date(until).getTime() - now;
  if (ms <= 0) return "resuming now";
  const min = Math.ceil(ms / 60_000);
  return ms < 60_000 ? `resuming in ${Math.ceil(ms / 1000)} s` : `resuming in ${min} minute${min === 1 ? "" : "s"}`;
}

export function ImportCard({ imp, onChanged }: { imp: ImportRow; onChanged: () => void }) {
  const active = ACTIVE.has(imp.status);
  const { data } = useJson<Detail>(`/api/imports/${imp.id}`, active ? 1500 : false);
  const [showRows, setShowRows] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const now = useNow(active);
  const resume = countdown(imp.status === "paused" ? imp.pausedUntil : null, now);
  const total = imp.totalRows ?? 0;
  const terminal = imp.counts.done + imp.counts.needsReview + imp.counts.failed;
  const elapsed = imp.startedAt ? (imp.finishedAt ? new Date(imp.finishedAt).getTime() : now) - new Date(imp.startedAt).getTime() : null;

  const retry = async () => {
    setRetrying(true);
    try {
      const r = await postJson<{ retried: number }>(`/api/imports/${imp.id}/retry`, {});
      toast.success(r.retried ? `Retrying ${r.retried} failed product${r.retried === 1 ? "" : "s"}` : "Nothing to retry: failed rows have no product to rebuild");
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <article className="overflow-hidden rounded-xl surface-card">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-2 p-4 pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold">{imp.fileName}</h3>
            <StatusBadge status={imp.status} />
          </div>
          <p className="mt-0.5 text-xs text-slate">
            Uploaded {relativeTime(imp.createdAt)}
            {imp.mode === "batch" && ", using the Batches API"}
            {imp.phase && active ? `. ${imp.phase}` : ""}
          </p>
        </div>
        <dl className="grid grid-cols-3 gap-x-5 text-right text-xs">
          <div>
            <dt className="text-slate">Elapsed</dt>
            <dd className="font-medium tabular-nums">{duration(elapsed)}</dd>
          </div>
          <div>
            <dt className="text-slate">AI cost</dt>
            <dd className="font-medium tabular-nums">{usd(imp.costNanos)}</dd>
          </div>
          <div>
            <dt className="text-slate">Products</dt>
            <dd className="font-medium tabular-nums">{imp.productsTotal === null ? "—" : int(imp.productsTotal)}</dd>
          </div>
        </dl>
      </header>

      {imp.status === "paused" && (
        <p role="status" className="mx-4 mb-3 rounded-md bg-review-soft px-3 py-2 text-sm text-review">
          Paused, {resume}. {imp.pauseReason}
        </p>
      )}
      {imp.status === "failed" && imp.error && (
        <p role="alert" className="mx-4 mb-3 rounded-md bg-fail-soft px-3 py-2 text-sm text-fail">
          {imp.error}
        </p>
      )}

      {total > 0 && (
        <div className="px-4">
          <RowStrip strip={data?.strip ?? ""} />
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums">
            <Legend colour="bg-ok" label="Done" value={imp.counts.done} />
            <Legend colour="bg-review" label="Needs review" value={imp.counts.needsReview} />
            <Legend colour="bg-fail" label="Failed" value={imp.counts.failed} />
            <Legend colour="bg-pending" label="In progress" value={imp.counts.pending + Math.max(0, total - terminal - imp.counts.pending)} />
            <span className="ml-auto text-slate">
              {data?.reconciliation.ok ? `All ${int(total)} rows accounted for` : `${int(terminal)} of ${int(total)} rows finished`}
            </span>
          </div>
        </div>
      )}

      <footer className="mt-3 flex flex-wrap items-center gap-2 border-t border-rule px-4 py-2.5">
        {total > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setShowRows((v) => !v)} aria-expanded={showRows}>
            {showRows ? "Hide rows" : "Show rows"}
          </Button>
        )}
        {imp.productsTotal ? (
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/products?import=${imp.id}`}>Review products</Link>
          </Button>
        ) : null}
        {imp.counts.failed > 0 && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={retry} disabled={retrying}>
            {retrying ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCcw aria-hidden />}
            Retry failed
          </Button>
        )}
      </footer>
      {showRows && (
        <div className="border-t border-rule">
          <RowsTable importId={imp.id} live={active} />
        </div>
      )}
    </article>
  );
}

function Legend({ colour, label, value }: { colour: string; label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`size-2 rounded-[1px] ${colour}`} aria-hidden />
      <span className="text-slate">{label}</span>
      <span className="font-medium">{int(value)}</span>
    </span>
  );
}
