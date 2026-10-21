"use client";

import { useState } from "react";
import { Check, Loader2, Pencil, RotateCcw, Send, ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { Claim, DroppedClaim } from "@/lib/ai/types";
import { duration, int, money, usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Card, FloatingBar, PageBody, PageHeader } from "./page";
import { Chip, Confidence, StatusBadge } from "./status";
import { postJson, useJson } from "./use-json";

interface Detail {
  product: {
    id: string;
    handle: string;
    status: string;
    reviewReason: string | null;
    title: string | null;
    descriptionHtml: string | null;
    category: string | null;
    tags: string[];
    attributes: Record<string, string>;
    claims: Claim[];
    droppedClaims: DroppedClaim[];
    confidence: Record<string, number>;
    sourceRows: number[];
    corrections: Array<{ row: number; column: string; kind: string; from: string; to: string }>;
    model: string | null;
    route: string | null;
    aiCostNanos: number;
    aiInputTokens: number;
    aiOutputTokens: number;
    processingMs: number | null;
    editedFields: string[];
    merchantNote: string | null;
    lastError: string | null;
  };
  variants: Array<{ id: string; sku: string; options: Record<string, string>; priceCents: number | null; currency: string | null; weightGrams: number | null; sourceRows: number[] }>;
  photos: Array<{ id: string; fileName: string; matchMethod: string; matchScore: number; sku: string | null }>;
  translations: Array<{ locale: string; field: string; text: string; status: string; error: string | null }>;
  rows: Array<{ rowNumber: number; raw: Record<string, string>; language: string; status: string }>;
  published: { handle: string; publishedAt: string } | null;
}

interface Draft {
  title: string;
  descriptionHtml: string;
  category: string;
  tags: string;
  attributes: string;
}

const toDraft = (p: Detail["product"]): Draft => ({
  title: p.title ?? "",
  descriptionHtml: p.descriptionHtml ?? "",
  category: p.category ?? "",
  tags: p.tags.join(", "),
  attributes: Object.entries(p.attributes).map(([k, v]) => `${k}: ${v}`).join("\n"),
});

function parseSource(source: string): { row: number; column: string } | null {
  const m = /^row (\d+), column (.+)$/.exec(source);
  return m ? { row: Number(m[1]), column: m[2] } : null;
}

export function ProductDetailView({ id }: { id: string }) {
  const { data, error, setData } = useJson<Detail>(`/api/products/${id}`, 4000);
  const { data: tax } = useJson<{ taxonomy: string[] }>("/api/categories");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [sendBack, setSendBack] = useState(false);
  const [note, setNote] = useState("");
  const [highlight, setHighlight] = useState<{ row: number; column: string } | null>(null);

  if (error && !data) return <PageBody><p className="rounded-md bg-fail-soft px-3 py-2 text-sm text-fail">{error}</p></PageBody>;
  if (!data) return <PageBody><p className="text-sm text-slate">Loading product…</p></PageBody>;
  const { product: p } = data;
  const editing = draft !== null;

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const attributes: Record<string, string> = {};
      for (const line of draft.attributes.split("\n")) {
        const i = line.indexOf(":");
        if (i > 0) attributes[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      const next = await postJson<Detail>(
        `/api/products/${id}`,
        {
          title: draft.title,
          descriptionHtml: draft.descriptionHtml,
          ...(draft.category ? { category: draft.category } : {}),
          tags: draft.tags.split(",").map((t) => t.trim()).filter(Boolean),
          attributes,
        },
        "PATCH",
      );
      setData(next);
      setDraft(null);
      toast.success("Changes saved", { description: "Translations will refresh in the background." });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const act = async (action: "approve" | "retry" | "send_back") => {
    setActing(action);
    try {
      const body = action === "send_back" ? { action, ids: [id], note } : { action, ids: [id] };
      const r = await postJson<{ approved?: number; skipped?: Array<{ reason: string }>; requeued?: number }>("/api/products/actions", body);
      if (action === "approve") {
        if (r.approved) toast.success("Published", { description: "Visible on the storefront preview." });
        else toast.error(`Not published: ${r.skipped?.[0]?.reason ?? "check the product"}`);
      } else {
        toast.success(action === "send_back" ? "Sent back to the AI with your note" : "Rebuild queued");
        setSendBack(false);
        setNote("");
      }
      const fresh = await fetch(`/api/products/${id}`, { cache: "no-store" }).then((res) => res.json());
      setData(fresh as Detail);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setActing(null);
    }
  };

  const reasons = p.reviewReason ? p.reviewReason.split("; ") : [];
  const columns = [...new Set(data.rows.flatMap((r) => Object.keys(r.raw)))];

  return (
    <PageBody className="pb-28">
      <PageHeader
        back={{ href: "/products", label: "Products" }}
        title={p.title ?? "Untitled product"}
        badges={
          <>
            <StatusBadge status={p.status} />
            {data.published && <Chip tone="success">Live on storefront</Chip>}
          </>
        }
        description={
          <>
            <span className="font-mono text-xs">/{p.handle}</span>
            {p.model && <span>, built by {p.model} ({p.route === "strong" ? "messy or needs photos" : "clean rows"})</span>}
          </>
        }
        actions={
          <>
            {!editing && (
              <Button variant="outline" onClick={() => setDraft(toDraft(p))} disabled={p.status === "pending"}>
                <Pencil aria-hidden />
                Edit
              </Button>
            )}
            <Button variant="outline" onClick={() => setSendBack(true)} disabled={p.status === "pending" || acting !== null}>
              <Send aria-hidden />
              Send back
            </Button>
            {(p.status === "failed" || p.status === "needs_review") && (
              <Button variant="outline" onClick={() => act("retry")} disabled={acting !== null}>
                {acting === "retry" ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCcw aria-hidden />}
                Rebuild
              </Button>
            )}
            <Button onClick={() => act("approve")} disabled={acting !== null || p.status === "pending" || p.status === "failed" || editing}>
              {acting === "approve" ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
              {p.status === "approved" ? "Republish" : "Approve and publish"}
            </Button>
          </>
        }
      />

      {(reasons.length > 0 || p.lastError) && (
        <Card className="border-l-4 border-review px-5 py-4">
          <h2 className="text-base font-semibold">{p.status === "failed" ? "Why it failed" : "Why it needs review"}</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {reasons.map((r) => (
              <li key={r} className="flex gap-2">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-review" aria-hidden />
                {r}
              </li>
            ))}
          </ul>
          {p.merchantNote && <p className="mt-3 text-sm text-slate">Your note to the AI: “{p.merchantNote}”</p>}
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        {/* AI result */}
        <div className="flex min-w-0 flex-col gap-6">
          <Card className="p-5">
            <div>
              <h2 className="text-base font-semibold">AI result</h2>
              <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Confidence per field">
                {Object.entries(p.confidence).map(([field, score]) => (
                  <Confidence key={field} label={field.replace("attributes.", "")} score={score} />
                ))}
              </div>
            </div>
            {editing ? (
              <div className="mt-4 grid gap-4">
                <Field label="Title">
                  <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                </Field>
                <Field label="Category">
                  <Select value={draft.category} onValueChange={(v) => setDraft({ ...draft, category: v })}>
                    <SelectTrigger className="w-full"><SelectValue placeholder="Choose a category" /></SelectTrigger>
                    <SelectContent>
                      {(tax?.taxonomy ?? []).map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Description (HTML: p, ul, li, strong, em)">
                  <Textarea rows={7} value={draft.descriptionHtml} onChange={(e) => setDraft({ ...draft, descriptionHtml: e.target.value })} className="font-mono text-xs" />
                </Field>
                <Field label="Tags, comma separated">
                  <Input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
                </Field>
                <Field label="Attributes, one “name: value” per line">
                  <Textarea rows={4} value={draft.attributes} onChange={(e) => setDraft({ ...draft, attributes: e.target.value })} />
                </Field>
              </div>
            ) : (
              <dl className="mt-4 grid gap-4 text-sm">
                <Row label="Category">{p.category ?? "—"}</Row>
                <Row label="Description">
                  <div className="prose-sm max-w-none [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-2" dangerouslySetInnerHTML={{ __html: p.descriptionHtml ?? "" }} />
                </Row>
                <Row label="Tags">
                  <div className="flex flex-wrap gap-1.5">{p.tags.map((t) => <Chip key={t} tone="neutral" dot={false}>{t}</Chip>)}</div>
                </Row>
                <Row label="Attributes">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                    {Object.entries(p.attributes).map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-slate capitalize">{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                  </dl>
                </Row>
                {p.editedFields.length > 0 && <p className="text-xs text-slate">Edited by you: {p.editedFields.join(", ")}. AI rebuilds keep these.</p>}
              </dl>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="text-base font-semibold">Claims and their sources</h2>
            <p className="mt-1 text-sm text-slate">Each claim was checked against the exact cell it cites. Hover one to highlight the cell.</p>
            <ul className="mt-3 divide-y divide-line">
              {p.claims.map((c) => {
                const src = parseSource(c.source);
                return (
                  <li key={c.text + c.source} className="flex gap-3 py-2.5" onMouseEnter={() => setHighlight(src)} onMouseLeave={() => setHighlight(null)} onFocus={() => setHighlight(src)} tabIndex={0}>
                    <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
                    <div className="min-w-0 text-sm">
                      <p className="font-medium">{c.text}</p>
                      <p className="text-xs text-slate">
                        {c.source}: “{c.quote}”
                      </p>
                    </div>
                  </li>
                );
              })}
              {p.droppedClaims.map((c) => (
                <li key={`d-${c.text}-${c.source}`} className="flex gap-3 py-2.5">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0 text-fail" aria-hidden />
                  <div className="min-w-0 text-sm">
                    <p className="font-medium text-fail line-through decoration-1">{c.text}</p>
                    <p className="text-xs text-slate">Removed: {c.reason}</p>
                  </div>
                </li>
              ))}
              {p.claims.length + p.droppedClaims.length === 0 && <li className="py-3 text-sm text-slate">No product claims in the supplier data.</li>}
            </ul>
          </Card>

          <Card>
            <h2 className="px-5 pt-5 text-base font-semibold">Variants</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-slate">
                  <tr className="text-left">
                    <th className="px-5 py-2 font-normal">SKU</th>
                    <th className="px-3 py-2 font-normal">Options</th>
                    <th className="px-3 py-2 text-right font-normal">Price</th>
                    <th className="px-3 py-2 text-right font-normal">Weight</th>
                    <th className="px-5 py-2 text-right font-normal">Rows</th>
                  </tr>
                </thead>
                <tbody>
                  {data.variants.map((v) => (
                    <tr key={v.id} className="border-t border-line">
                      <td className="px-5 py-2.5 font-mono text-xs">{v.sku}</td>
                      <td className="px-3 py-2.5">{Object.values(v.options).join(" / ") || "—"}</td>
                      <td className={cn("px-3 py-2.5 text-right tabular-nums", v.priceCents === null && "font-medium text-fail")}>{v.priceCents === null ? "Missing" : money(v.priceCents, v.currency)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{v.weightGrams === null ? "—" : `${int(v.weightGrams)} g`}</td>
                      <td className="px-5 py-2.5 text-right text-xs text-slate">{v.sourceRows.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Translations data={data} productId={id} onSaved={setData} />
        </div>

        {/* Source data */}
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <div className="px-5 pt-5">
              <h2 className="text-base font-semibold">Supplier rows</h2>
              <p className="mt-1 text-sm text-slate">Exactly as uploaded: rows {p.sourceRows.join(", ")}.</p>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate">
                    <th className="sticky left-0 bg-white px-5 py-2 font-normal">Column</th>
                    {data.rows.map((r) => (
                      <th key={r.rowNumber} className="px-3 py-2 font-normal whitespace-nowrap">
                        Row {r.rowNumber} <span className="uppercase">{r.language === "unknown" ? "" : r.language}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {columns.map((col) => (
                    <tr key={col} className="border-t border-line align-top">
                      <th scope="row" className="sticky left-0 bg-white px-5 py-2 text-left font-medium whitespace-nowrap">{col}</th>
                      {data.rows.map((r) => {
                        const hit = highlight && highlight.row === r.rowNumber && highlight.column === col;
                        return (
                          <td key={r.rowNumber} className={cn("max-w-64 px-3 py-2 break-words transition-colors", hit && "bg-review-soft ring-2 ring-review ring-inset")}>
                            {r.raw[col] ? <span className="line-clamp-4">{r.raw[col]}</span> : <span className="text-slate-soft">empty</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="text-base font-semibold">Photos</h2>
            {data.photos.length === 0 ? (
              <p className="mt-2 text-sm text-slate">No photo matched this product.</p>
            ) : (
              <ul className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-4">
                {data.photos.map((ph) => (
                  <li key={ph.id} className="min-w-0">
                    {/* eslint-disable-next-line @next/next/no-img-element -- photos come from our immutable photo route */}
                    <img src={`/api/photos/${ph.id}`} alt={ph.fileName} className="aspect-square w-full rounded-lg border border-rule object-cover" />
                    <p className="mt-1 truncate text-xs" title={ph.fileName}>{ph.fileName}</p>
                    <p className="text-[0.7rem] text-slate">matched by {ph.matchMethod.replace("_", " ")} ({ph.matchScore}%)</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="text-base font-semibold">Cleaning applied</h2>
            {p.corrections.length === 0 ? (
              <p className="mt-2 text-sm text-slate">Nothing needed fixing.</p>
            ) : (
              <ul className="mt-3 max-h-64 space-y-1.5 overflow-y-auto text-xs">
                {p.corrections.slice(0, 60).map((c, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="w-14 shrink-0 text-slate">row {c.row}</span>
                    <span className="min-w-0">
                      <span className="text-slate">{c.column}:</span> <span className="line-through decoration-slate-soft">{c.from.slice(0, 60)}</span> → {c.to} <span className="text-slate">({c.kind.replace(/_/g, " ")})</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="grid grid-cols-2 gap-px bg-rule sm:grid-cols-4">
            <Stat label="AI cost" value={usd(p.aiCostNanos)} />
            <Stat label="Tokens in" value={int(p.aiInputTokens)} />
            <Stat label="Tokens out" value={int(p.aiOutputTokens)} />
            <Stat label="Build time" value={duration(p.processingMs)} />
          </Card>
        </div>
      </div>

      {editing && (
        <FloatingBar label="Unsaved changes">
          <Pencil className="size-4 text-slate" aria-hidden />
          <span>Unsaved changes</span>
          <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setDraft(null)} disabled={saving}>Discard</Button>
          <Button size="sm" className="rounded-full" onClick={save} disabled={saving}>
            {saving && <Loader2 className="animate-spin" aria-hidden />}
            Save
          </Button>
        </FloatingBar>
      )}

      <Dialog open={sendBack} onOpenChange={setSendBack}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send back to the AI</DialogTitle>
            <DialogDescription>The product is unpublished and rebuilt with your note. Your manual edits are kept.</DialogDescription>
          </DialogHeader>
          <Textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: the material is stoneware, not ceramic. Keep the title shorter." aria-label="Note for the AI" />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSendBack(false)}>Cancel</Button>
            <Button onClick={() => act("send_back")} disabled={note.trim().length < 3 || acting !== null}>
              {acting === "send_back" && <Loader2 className="animate-spin" aria-hidden />}
              Send back
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageBody>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[7rem_1fr]">
      <dt className="text-slate">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 bg-white p-4">
      <span className="text-[0.8125rem] text-slate">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
    </div>
  );
}

const TR_STATUS: Record<string, string> = { machine: "AI translated", manual: "Edited by you", out_of_date: "Out of date", failed: "Failed, showing English" };

function Translations({ data, productId, onSaved }: { data: Detail; productId: string; onSaved: (d: Detail) => void }) {
  const [editing, setEditing] = useState<{ locale: string; field: string; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const find = (locale: string, field: string) => data.translations.find((t) => t.locale === locale && t.field === field);

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      onSaved(await postJson<Detail>(`/api/products/${productId}/translations`, editing, "PUT"));
      setEditing(null);
      toast.success("Translation saved. Your version always wins.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold">Translations</h2>
      <Tabs defaultValue="de" className="mt-3">
        <TabsList>
          <TabsTrigger value="de">German</TabsTrigger>
          <TabsTrigger value="fr">French</TabsTrigger>
        </TabsList>
        {(["de", "fr"] as const).map((locale) => (
          <TabsContent key={locale} value={locale} className="mt-3 grid gap-4">
            {(["title", "descriptionHtml"] as const).map((field) => {
              const t = find(locale, field);
              const isEditing = editing?.locale === locale && editing.field === field;
              return (
                <div key={field} className="grid gap-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{field === "title" ? "Title" : "Description"}</span>
                    {t ? (
                      <Chip tone={t.status === "machine" ? "info" : t.status === "manual" ? "violet" : t.status === "out_of_date" ? "attention" : "danger"}>{TR_STATUS[t.status]}</Chip>
                    ) : (
                      <Chip tone="neutral">Not translated yet</Chip>
                    )}
                    {!isEditing && (
                      <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setEditing({ locale, field, text: t?.text ?? "" })}>
                        Edit
                      </Button>
                    )}
                  </div>
                  {isEditing ? (
                    <div className="grid gap-2">
                      <Textarea rows={field === "title" ? 2 : 6} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} className={field === "descriptionHtml" ? "font-mono text-xs" : undefined} />
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                        <Button size="sm" onClick={save} disabled={saving || !editing.text.trim()}>Save translation</Button>
                      </div>
                    </div>
                  ) : field === "title" ? (
                    <p className="text-sm">{t?.text ?? "—"}</p>
                  ) : (
                    <div className="text-sm [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-2" dangerouslySetInnerHTML={{ __html: t?.text ?? "—" }} />
                  )}
                  {t?.status === "out_of_date" && <p className="text-xs text-review">The English changed after you edited this. Your text is kept; update it if needed.</p>}
                  {t?.error && <p className="text-xs text-fail">{t.error}</p>}
                </div>
              );
            })}
          </TabsContent>
        ))}
      </Tabs>
    </Card>
  );
}
