"use client";

import { useState } from "react";
import { usd } from "@/lib/format";

interface Point {
  bucket: string;
  costNanos: number;
  baselineNanos: number;
}

// Validated pair (dataviz validator: CVD ΔE 31.7, contrast ≥ 3:1). Baseline is also dashed.
const ACTUAL = "#2563eb";
const BASELINE = "#c2410c";

/** Cumulative AI spend vs the "always strong model, no batching" baseline, one shared y-axis. */
export function CostChart({ points }: { points: Point[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = 220;
  const pad = { l: 56, r: 16, t: 12, b: 28 };
  const series: Array<{ t: Date; actual: number; baseline: number }> = [];
  for (const p of points) {
    const prev = series[series.length - 1];
    series.push({ t: new Date(p.bucket), actual: (prev?.actual ?? 0) + p.costNanos, baseline: (prev?.baseline ?? 0) + p.baselineNanos });
  }
  if (series.length === 1) series.unshift({ t: new Date(series[0].t.getTime() - 60_000), actual: 0, baseline: 0 });
  if (series.length === 0) return <p className="text-sm text-slate">No AI calls yet.</p>;
  const max = Math.max(...series.map((s) => s.baseline), 1);
  const x = (i: number) => pad.l + (i / Math.max(1, series.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const path = (key: "actual" | "baseline") => series.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s[key]).toFixed(1)}`).join(" ");
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const fmtTime = (d: Date) => d.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
  const last = series[series.length - 1];
  const h = hover === null ? null : series[hover];

  return (
    <figure className="m-0">
      <div className="mb-3 flex flex-wrap gap-4 text-xs">
        <Key colour={ACTUAL} label="Actual spend" />
        <Key colour={BASELINE} label="Baseline: strong model, sync, no caching" dashed />
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          role="img"
          aria-label={`Cumulative AI cost ${usd(last.actual)} versus baseline ${usd(last.baseline)}`}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const px = ((e.clientX - rect.left) / rect.width) * W;
            const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (series.length - 1));
            setHover(Math.max(0, Math.min(series.length - 1, i)));
          }}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--line)" />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="fill-slate text-[11px] tabular-nums">{usd(t)}</text>
            </g>
          ))}
          <text x={pad.l} y={H - 8} className="fill-slate text-[11px]">{fmtTime(series[0].t)}</text>
          <text x={W - pad.r} y={H - 8} textAnchor="end" className="fill-slate text-[11px]">{fmtTime(last.t)}</text>
          <path d={path("baseline")} fill="none" stroke={BASELINE} strokeWidth={2} strokeDasharray="6 4" strokeLinejoin="round" />
          <path d={path("actual")} fill="none" stroke={ACTUAL} strokeWidth={2} strokeLinejoin="round" />
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--rule-strong)" />
              <circle cx={x(hover)} cy={y(series[hover].baseline)} r={4.5} fill={BASELINE} stroke="#fff" strokeWidth={2} />
              <circle cx={x(hover)} cy={y(series[hover].actual)} r={4.5} fill={ACTUAL} stroke="#fff" strokeWidth={2} />
            </g>
          )}
        </svg>
        {h && hover !== null && (
          <div
            className="pointer-events-none absolute top-2 rounded-lg bg-white px-3 py-2 text-xs shadow-[var(--shadow-card)]"
            style={{ left: `${(x(hover) / W) * 100}%`, transform: hover > series.length / 2 ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}
          >
            <p className="font-medium">{h.t.toLocaleString("en", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}</p>
            <p className="mt-1 tabular-nums">Actual {usd(h.actual)}</p>
            <p className="tabular-nums">Baseline {usd(h.baseline)}</p>
            <p className="text-slate tabular-nums">Saved {usd(h.baseline - h.actual)}</p>
          </div>
        )}
      </div>
    </figure>
  );
}

function Key({ colour, label, dashed }: { colour: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 text-slate">
      <svg width="18" height="6" aria-hidden>
        <line x1="0" x2="18" y1="3" y2="3" stroke={colour} strokeWidth="2" strokeDasharray={dashed ? "5 3" : undefined} />
      </svg>
      {label}
    </span>
  );
}
