"use client";

import Link from "next/link";
import type { Metrics } from "@/lib/metrics";
import { duration, int, pct, usd } from "@/lib/format";
import { CostChart } from "./cost-chart";
import { Card, PageBody, PageHeader } from "./page";
import { useJson } from "./use-json";

export function MetricsView() {
  const { data: m, error } = useJson<Metrics>("/api/metrics", 5000);
  if (error && !m) return <PageBody><p className="rounded-md bg-fail-soft px-3 py-2 text-sm text-fail">{error}</p></PageBody>;
  if (!m) return <PageBody><p className="text-sm text-slate">Loading metrics…</p></PageBody>;
  const p = m.products;
  const r = m.rows;
  const saved = m.cost.savedNanos;

  return (
    <PageBody>
      <PageHeader title="Metrics" description="Throughput, accuracy and what the AI cost, across every import." />

      <StatStrip
        items={[
          { label: "Products processed", value: int(p.processed), sub: `of ${int(p.total)}` },
          { label: "Ready or published", value: pct(p.done + p.approved, p.processed), sub: `${int(p.done + p.approved)} products` },
          { label: "Need review", value: pct(p.needs_review, p.processed), sub: `${int(p.needs_review)} products` },
          { label: "Failed", value: pct(p.failed, p.processed), sub: `${int(p.failed)} products` },
          { label: "Rows reconciled", value: int(r.total - r.pending), sub: `${int(r.pending)} in progress` },
          { label: "AI spend", value: usd(m.cost.actualNanos), sub: `${usd(m.cost.perProductNanos)} per product` },
        ]}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_23.5rem]">
        <Card className="p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold">AI cost over time</h2>
            <p className="text-sm text-slate">
              Spent <span className="font-semibold text-ink tabular-nums">{usd(m.cost.actualNanos)}</span>, saved{" "}
              <span className="font-semibold text-ink tabular-nums">{usd(saved)}</span> ({pct(saved, m.cost.baselineNanos)})
            </p>
          </div>
          <div className="mt-4">
            <CostChart points={m.costOverTime} />
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="text-base font-semibold">Where the savings come from</h2>
          <p className="mt-1 text-sm text-slate">Against sending every product to the strong model, one call at a time, without prompt caching.</p>
          <dl className="mt-4 grid gap-3 text-sm">
            <SavingRow label="Routing clean rows to the cheap model" value={m.cost.savedRoutingNanos} total={saved} />
            <SavingRow label="Message Batches API (50% off)" value={m.cost.savedBatchingNanos} total={saved} />
            <SavingRow label="Prompt caching of the system prompt" value={m.cost.savedCachingNanos} total={saved} />
          </dl>
          <div className="mt-5 grid grid-cols-2 gap-3 border-t border-line pt-4 text-sm">
            <div>
              <p className="text-slate">Per product</p>
              <p className="text-lg font-semibold tabular-nums">{usd(m.cost.perProductNanos)}</p>
            </div>
            <div>
              <p className="text-slate">Baseline total</p>
              <p className="text-lg font-semibold tabular-nums">{usd(m.cost.baselineNanos)}</p>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <h2 className="px-5 pt-5 text-base font-semibold">Model usage</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="text-xs text-slate">
              <tr className="text-left">
                <th className="px-5 py-2 font-normal">Model</th>
                <th className="px-3 py-2 font-normal">Work</th>
                <th className="px-3 py-2 font-normal">Mode</th>
                <th className="px-3 py-2 text-right font-normal">Calls</th>
                <th className="px-3 py-2 text-right font-normal">Products</th>
                <th className="px-3 py-2 text-right font-normal">Tokens in / out</th>
                <th className="px-5 py-2 text-right font-normal">Cost</th>
              </tr>
            </thead>
            <tbody>
              {m.models.map((row) => (
                <tr key={`${row.model}-${row.mode}-${row.kind}`} className="h-12 border-t border-line">
                  <td className="px-5 font-medium">{row.model}</td>
                  <td className="px-3">{row.kind === "build" ? `Build${row.visionCalls ? ` (${int(row.visionCalls)} with photos)` : ""}` : "Translate"}</td>
                  <td className="px-3">{row.mode === "batch" ? "Batches API" : "Synchronous"}</td>
                  <td className="px-3 text-right tabular-nums">{int(row.calls)}</td>
                  <td className="px-3 text-right tabular-nums">{int(row.products)}</td>
                  <td className="px-3 text-right tabular-nums">{int(row.inputTokens)} / {int(row.outputTokens)}</td>
                  <td className="px-5 text-right font-medium tabular-nums">{usd(row.costNanos)}</td>
                </tr>
              ))}
              {m.models.length === 0 && (
                <tr><td colSpan={7} className="px-5 py-6 text-center text-slate">No AI calls yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-5 py-3 text-xs text-slate">
          Call outcomes: {Object.entries(m.aiOutcomes).map(([k, v]) => `${int(v)} ${k.replace("_", " ")}`).join(", ") || "none"}. Invalid output and errors were retried.
        </p>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="text-base font-semibold">Speed</h2>
          <div className="mt-4 grid grid-cols-3 gap-px overflow-hidden rounded-lg bg-rule">
            <Mini label="Average" value={duration(m.speed.avgMs)} />
            <Mini label="p95" value={duration(m.speed.p95Ms)} />
            <Mini label="Slowest" value={duration(m.speed.maxMs)} />
          </div>
          <p className="mt-2 text-xs text-slate">Per product, from the start of its AI call to its result being saved.</p>
          <h3 className="mt-4 text-sm font-medium">Slowest products</h3>
          <ul className="mt-2 divide-y divide-line text-sm">
            {m.speed.slowest.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2">
                <Link href={`/products/${s.id}`} className="min-w-0 flex-1 truncate hover:underline">{s.title ?? s.handle}</Link>
                <span className="text-xs text-slate">{s.model}</span>
                <span className="w-16 text-right tabular-nums">{duration(s.ms)}</span>
              </li>
            ))}
          </ul>
          <h3 className="mt-4 text-sm font-medium">Recent imports</h3>
          <ul className="mt-2 divide-y divide-line text-sm">
            {m.imports.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate">{i.fileName}</span>
                <span className="text-xs text-slate">{int(i.rows)} rows</span>
                <span className="w-20 text-right tabular-nums">{duration(i.seconds * 1000)}</span>
                <span className="w-20 text-right text-xs text-slate tabular-nums">{i.rowsPerSecond} rows/s</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-5">
          <h2 className="text-base font-semibold">Translations</h2>
          <div className="mt-4 grid gap-5">
            {Object.entries(m.translation).map(([locale, c]) => {
              const covered = c.translated + c.manual + c.outOfDate;
              return (
                <div key={locale}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-medium">{locale === "de" ? "German" : "French"}</span>
                    <span className="tabular-nums">{pct(covered, c.expected)} covered</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary" role="img" aria-label={`${pct(covered, c.expected)} of fields translated`}>
                    <div className="h-full rounded-full bg-[#2563eb]" style={{ width: `${c.expected ? Math.min(100, (covered / c.expected) * 100) : 0}%` }} />
                  </div>
                  <p className="mt-1.5 text-xs text-slate tabular-nums">
                    {int(c.translated)} by AI, {int(c.manual)} edited by you, {int(c.outOfDate)} out of date, {int(c.failed)} failed guard checks (English shown)
                  </p>
                </div>
              );
            })}
          </div>
          <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-rule">
            <Mini label="Out-of-date edits" value={int(m.outOfDate)} href="/products?outOfDate=1" />
            <Mini label="Claims verified" value={int(m.claims.kept)} />
            <Mini label="Claims removed" value={int(m.claims.dropped)} />
            <Mini label="Products with removed claims" value={int(m.claims.productsWithDropped)} />
          </div>
        </Card>
      </div>
    </PageBody>
  );
}

function StatStrip({ items }: { items: Array<{ label: string; value: string; sub?: string }> }) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-rule shadow-[var(--shadow-card)] lg:auto-cols-fr lg:grid-flow-col">
      {items.map((s) => (
        <div key={s.label} className="flex flex-col gap-1.5 bg-white p-4">
          <span className="text-[0.8125rem] text-slate">{s.label}</span>
          <span className="text-[1.75rem] leading-[2.125rem] font-semibold tracking-[-0.02em] tabular-nums">{s.value}</span>
          {s.sub && <span className="text-xs text-slate">{s.sub}</span>}
        </div>
      ))}
    </div>
  );
}

function Mini({ label, value, href }: { label: string; value: string; href?: string }) {
  const body = (
    <>
      <span className="text-xs text-slate">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
    </>
  );
  return href ? (
    <Link href={href} className="flex flex-col gap-0.5 bg-white p-3 hover:bg-row-hover">{body}</Link>
  ) : (
    <div className="flex flex-col gap-0.5 bg-white p-3">{body}</div>
  );
}

function SavingRow({ label, value, total }: { label: string; value: number; total: number }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-slate">{label}</dt>
        <dd className="font-medium tabular-nums">{usd(value)}</dd>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden>
        <div className="h-full rounded-full bg-ink" style={{ width: `${total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0}%` }} />
      </div>
    </div>
  );
}
