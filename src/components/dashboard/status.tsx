import { STATUS_LABEL } from "@/lib/format";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "attention" | "info" | "danger" | "success" | "violet";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-neutral-border bg-neutral-soft text-neutral",
  attention: "border-review-border bg-review-soft text-review",
  info: "border-info-border bg-info-soft text-info",
  danger: "border-fail-border bg-fail-soft text-fail",
  success: "border-ok-border bg-ok-soft text-ok",
  violet: "border-violet-border bg-violet-soft text-violet",
};

const STATUS_TONE: Record<string, Tone> = {
  pending: "neutral",
  queued: "neutral",
  parsing: "violet",
  building: "violet",
  done: "info",
  completed: "success",
  approved: "success",
  needs_review: "attention",
  paused: "attention",
  failed: "danger",
  machine: "info",
  manual: "violet",
  out_of_date: "attention",
};

export function Chip({ tone, children, className, dot = true }: { tone: Tone; children: React.ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn("inline-flex h-[1.375rem] shrink-0 items-center gap-1.5 rounded-[0.375rem] border px-2 text-xs font-medium whitespace-nowrap", TONE_CLASS[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Chip tone={STATUS_TONE[status] ?? "neutral"} className={className}>
      {STATUS_LABEL[status] ?? status}
    </Chip>
  );
}

export function confidenceTone(score: number | null | undefined, threshold = 70): "high" | "mid" | "low" | "none" {
  if (score === null || score === undefined) return "none";
  if (score < threshold) return "low";
  if (score < 90) return "mid";
  return "high";
}

const CONF_TONE: Record<string, Tone> = { high: "success", mid: "attention", low: "danger", none: "neutral" };

/** Colour-coded confidence: green ≥ 90, amber 70–89, red < 70 (the review threshold). */
export function Confidence({ score, label, className }: { score: number | null | undefined; label?: string; className?: string }) {
  return (
    <Chip tone={CONF_TONE[confidenceTone(score)]} dot={false} className={cn("tabular-nums", className)}>
      {label && <span className="font-normal opacity-80">{label}</span>}
      {score ?? "—"}
    </Chip>
  );
}
