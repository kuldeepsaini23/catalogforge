"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp, Check, Download, Loader2, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { duration, money, relativeTime, usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Card, FloatingBar, PageBody, PageHeader } from "./page";
import { Pagination } from "./pagination";
import { Confidence, StatusBadge } from "./status";
import { postJson, useJson } from "./use-json";

interface Item {
  id: string;
  handle: string;
  title: string | null;
  status: string;
  category: string | null;
  minConfidence: number | null;
  reviewReason: string | null;
  model: string | null;
  route: string | null;
  aiCostNanos: number;
  processingMs: number | null;
  updatedAt: string;
  variantCount: number;
  priceMin: number | null;
  currency: string | null;
  photoId: string | null;
}

const ALL = "all";
const STATUS_OPTIONS = [
  { value: ALL, label: "All statuses" },
  { value: "needs_review", label: "Needs review" },
  { value: "done", label: "Ready" },
  { value: "approved", label: "Published" },
  { value: "failed", label: "Failed" },
  { value: "pending", label: "Processing" },
];
const CONFIDENCE_OPTIONS = [
  { value: ALL, label: "Any confidence" },
  { value: "low", label: "Low (under 70)" },
  { value: "mid", label: "Medium (70–89)" },
  { value: "high", label: "High (90+)" },
];

export function ProductsView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const get = (k: string, d = "") => params.get(k) ?? d;
  const page = Number(get("page", "1")) || 1;
  const size = Number(get("size", "25")) || 25;
  const sort = get("sort", "updated");
  const dir = get("dir", "desc");
  const [q, setQ] = useState(get("q"));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const update = (patch: Record<string, string | number | null>, resetPage = true) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "" || v === ALL) next.delete(k);
      else next.set(k, String(v));
    }
    if (resetPage && !("page" in patch)) next.delete("page");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  // Debounced search box → URL.
  useEffect(() => {
    if (q === get("q")) return;
    const t = setTimeout(() => update({ q }), 300);
    return () => clearTimeout(t);
  });

  const query = new URLSearchParams(params.toString());
  query.set("page", String(page));
  query.set("size", String(size));
  const { data, error, refresh } = useJson<{ items: Item[]; total: number }>(`/api/products?${query.toString()}`, 5000);
  const { data: cats } = useJson<{ used: string[] }>("/api/categories");
  const items = data?.items ?? [];
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));

  const toggleSort = (col: string) => {
    if (sort === col) update({ dir: dir === "asc" ? "desc" : "asc" }, false);
    else update({ sort: col, dir: col === "title" || col === "category" || col === "confidence" ? "asc" : "desc" }, false);
  };

  const approve = async () => {
    setBusy(true);
    try {
      const r = await postJson<{ approved: number; skipped: Array<{ id: string; reason: string }> }>("/api/products/actions", { action: "approve", ids: [...selected] });
      toast.success(`Published ${r.approved} product${r.approved === 1 ? "" : "s"}`, {
        description: r.skipped.length ? `${r.skipped.length} skipped: ${[...new Set(r.skipped.map((s) => s.reason))].join(", ")}` : undefined,
      });
      setSelected(new Set());
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageBody>
      <PageHeader
        title="Products"
        description="Review what the AI built, fix what it flagged, and publish."
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                <Download aria-hidden />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Published products</DropdownMenuLabel>
              <DropdownMenuItem asChild><a href="/api/export?format=csv&scope=approved">CSV, one row per variant</a></DropdownMenuItem>
              <DropdownMenuItem asChild><a href="/api/export?format=json&scope=approved&translations=1">JSON with translations</a></DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Everything built so far</DropdownMenuLabel>
              <DropdownMenuItem asChild><a href="/api/export?format=csv&scope=all">CSV, one row per variant</a></DropdownMenuItem>
              <DropdownMenuItem asChild><a href="/api/export?format=json&scope=all&translations=1">JSON with translations</a></DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-rule py-2 pr-2 pl-1.5">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, handle or SKU" className="h-8 border-0 pl-8 shadow-none focus-visible:bg-muted/60 focus-visible:ring-0" aria-label="Search products" />
          </div>
          <FilterSelect value={get("status", ALL)} onChange={(v) => update({ status: v })} options={STATUS_OPTIONS} label="Status" />
          <FilterSelect value={get("confidence", ALL)} onChange={(v) => update({ confidence: v })} options={CONFIDENCE_OPTIONS} label="Confidence" />
          <FilterSelect
            value={get("category", ALL)}
            onChange={(v) => update({ category: v })}
            options={[{ value: ALL, label: "All categories" }, ...(cats?.used ?? []).map((c) => ({ value: c, label: c.split(" > ").slice(-1)[0] }))]}
            label="Category"
          />
          <Button variant={get("outOfDate") ? "secondary" : "ghost"} size="sm" onClick={() => update({ outOfDate: get("outOfDate") ? null : "1" })} aria-pressed={Boolean(get("outOfDate"))}>
            {get("outOfDate") && <Check aria-hidden />}
            Out-of-date translations
          </Button>
          {get("import") && (
            <Button variant="secondary" size="sm" onClick={() => update({ import: null })}>
              From one import
              <X aria-hidden />
            </Button>
          )}
        </div>

        {selected.size > 0 && (
          <FloatingBar label="Bulk actions">
            <span className="font-medium tabular-nums">{selected.size} selected</span>
            <Button size="sm" className="rounded-full" onClick={approve} disabled={busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              Approve and publish
            </Button>
            <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </FloatingBar>
        )}

        {error && <p className="px-4 py-3 text-sm text-fail">Could not load products: {error}</p>}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 pl-4">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={(v) => {
                      const next = new Set(selected);
                      for (const i of items) {
                        if (v) next.add(i.id);
                        else next.delete(i.id);
                      }
                      setSelected(next);
                    }}
                    aria-label="Select all on this page"
                  />
                </TableHead>
                <SortHead sort={sort} dir={dir} onSort={toggleSort} col="title">Product</SortHead>
                <SortHead sort={sort} dir={dir} onSort={toggleSort} col="status">Status</SortHead>
                <SortHead sort={sort} dir={dir} onSort={toggleSort} col="confidence">Confidence</SortHead>
                <SortHead sort={sort} dir={dir} onSort={toggleSort} col="category" className="hidden lg:table-cell">Category</SortHead>
                <TableHead className="text-right">Price from</TableHead>
                <SortHead sort={sort} dir={dir} onSort={toggleSort} col="cost" className="hidden text-right md:table-cell">AI cost</SortHead>
                <SortHead sort={sort} dir={dir} onSort={toggleSort} col="speed" className="hidden text-right xl:table-cell">Build time</SortHead>
                <SortHead sort={sort} dir={dir} onSort={toggleSort} col="updated" className="hidden pr-4 text-right md:table-cell">Updated</SortHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((p) => (
                <TableRow key={p.id} className="h-15" data-state={selected.has(p.id) ? "selected" : undefined}>
                  <TableCell className="pl-4">
                    <Checkbox
                      checked={selected.has(p.id)}
                      onCheckedChange={(v) => {
                        const next = new Set(selected);
                        if (v) next.add(p.id);
                        else next.delete(p.id);
                        setSelected(next);
                      }}
                      aria-label={`Select ${p.title ?? p.handle}`}
                    />
                  </TableCell>
                  <TableCell className="min-w-64">
                    <div className="flex items-center gap-3">
                      <Thumb photoId={p.photoId} />
                      <div className="min-w-0">
                        <Link href={`/products/${p.id}`} className="block truncate font-medium hover:underline">
                          {p.title ?? "Untitled product"}
                        </Link>
                        <p className="truncate text-xs text-slate">
                          {p.variantCount} variant{p.variantCount === 1 ? "" : "s"}
                          {p.model ? `, ${p.model.replace("claude-", "")}` : ""}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-64">
                    <StatusBadge status={p.status} />
                    {p.reviewReason && p.status === "needs_review" && (
                      <p className="mt-1 line-clamp-1 text-xs text-slate" title={p.reviewReason}>{p.reviewReason}</p>
                    )}
                  </TableCell>
                  <TableCell>
                    <Confidence score={p.minConfidence} />
                  </TableCell>
                  <TableCell className="hidden max-w-56 truncate text-sm text-slate lg:table-cell" title={p.category ?? undefined}>
                    {p.category?.split(" > ").slice(-1)[0] ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(p.priceMin, p.currency)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums text-slate md:table-cell">{usd(p.aiCostNanos)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums text-slate xl:table-cell">{duration(p.processingMs)}</TableCell>
                  <TableCell className="hidden pr-4 text-right text-sm whitespace-nowrap text-slate md:table-cell">{relativeTime(p.updatedAt)}</TableCell>
                </TableRow>
              ))}
              {data && items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-12 text-center text-sm text-slate">
                    {params.toString() ? "No products match these filters." : "No products yet. Start an import to build some."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {data && (
          <div className="border-t border-rule">
            <Pagination page={page} size={size} total={data.total} onPage={(p) => update({ page: p }, false)} onSize={(s) => update({ size: s })} />
          </div>
        )}
      </Card>
    </PageBody>
  );
}

function SortHead({ col, sort, dir, onSort, children, className }: { col: string; sort: string; dir: string; onSort: (col: string) => void; children: React.ReactNode; className?: string }) {
  return (
    <TableHead className={className} aria-sort={sort === col ? (dir === "asc" ? "ascending" : "descending") : undefined}>
      <button type="button" onClick={() => onSort(col)} className="inline-flex items-center gap-1 hover:text-ink">
        {children}
        {sort === col && (dir === "asc" ? <ArrowUp className="size-3" aria-hidden /> : <ArrowDown className="size-3" aria-hidden />)}
      </button>
    </TableHead>
  );
}

function FilterSelect({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>; label: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className={cn("w-auto min-w-32 border-transparent shadow-none hover:bg-muted", value !== ALL && "border-rule-strong bg-secondary font-medium")} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Thumb({ photoId }: { photoId: string | null }) {
  if (!photoId) return <div className="size-9 shrink-0 rounded bg-secondary" aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element -- served from our own photo route with immutable caching
  return <img src={`/api/photos/${photoId}`} alt="" width={36} height={36} loading="lazy" className="size-9 shrink-0 rounded object-cover" />;
}
