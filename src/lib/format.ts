/** Client-safe formatting helpers (no server imports). */

export function money(cents: number | null | undefined, currency: string | null | undefined, locale = "en"): string {
  if (cents === null || cents === undefined || !currency) return "—";
  const digits = currency === "JPY" ? 0 : 2;
  const major = Math.trunc(cents / 10 ** digits);
  const minor = Math.abs(cents % 10 ** digits).toString().padStart(digits, "0");
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(Number(digits ? `${major}.${minor}` : `${major}`));
}

export function usd(nanos: number): string {
  const v = nanos / 1e9;
  if (v === 0) return "$0.00";
  if (Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
  if (Math.abs(v) < 10) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

export function int(n: number): string {
  return new Intl.NumberFormat("en").format(n);
}

export function pct(part: number, whole: number): string {
  if (!whole) return "0%";
  const p = (part / whole) * 100;
  return `${p < 10 && p > 0 ? p.toFixed(1) : Math.round(p)}%`;
}

export function relativeTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return d.toLocaleDateString("en", { day: "numeric", month: "short" });
}

export const STATUS_LABEL: Record<string, string> = {
  pending: "Processing",
  done: "Ready",
  needs_review: "Needs review",
  failed: "Failed",
  approved: "Published",
  queued: "Queued",
  parsing: "Reading sheet",
  building: "Building",
  paused: "Paused",
  completed: "Completed",
};
