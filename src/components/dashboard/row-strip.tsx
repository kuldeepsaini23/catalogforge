"use client";

import { useEffect, useRef } from "react";

const COLOURS: Record<string, string> = { p: "--pending", d: "--ok", r: "--review", f: "--fail" };

/**
 * One segment per sheet row, in sheet order: the whole import at a glance. Rendered to a canvas so
 * 10,000 rows cost one paint, not 10,000 DOM nodes.
 */
export function RowStrip({ strip, height = 14 }: { strip: string; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.floor(height * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const styles = getComputedStyle(canvas);
      const colour = Object.fromEntries(Object.entries(COLOURS).map(([k, v]) => [k, styles.getPropertyValue(v).trim() || "#999"]));
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const n = strip.length;
      if (!n) return;
      const w = canvas.width / n;
      // Run-length draw: consecutive rows with the same status become one rectangle.
      let start = 0;
      for (let i = 1; i <= n; i++) {
        if (i === n || strip[i] !== strip[start]) {
          ctx.fillStyle = colour[strip[start]] ?? colour.p;
          ctx.fillRect(Math.floor(start * w), 0, Math.ceil((i - start) * w), canvas.height);
          start = i;
        }
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [strip, height]);

  const counts = { d: 0, r: 0, f: 0, p: 0 } as Record<string, number>;
  for (const ch of strip) counts[ch] = (counts[ch] ?? 0) + 1;
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={`${strip.length} rows: ${counts.d} done, ${counts.r} need review, ${counts.f} failed, ${counts.p} in progress`}
      className="block w-full rounded-[2px] bg-secondary"
      style={{ height }}
    />
  );
}
