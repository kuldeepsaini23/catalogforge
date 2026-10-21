"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

/** Top bar: global product search (title, handle or SKU) that jumps to the Products tab. */
export function TopBar() {
  const router = useRouter();
  const [q, setQ] = useState("");
  return (
    <div className="flex h-14 items-center gap-3 px-3 md:px-4">
      <form
        role="search"
        className="relative w-full max-w-80"
        onSubmit={(e) => {
          e.preventDefault();
          router.push(`/products${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);
        }}
      >
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search products or SKUs"
          aria-label="Search products or SKUs"
          className="h-9 w-full rounded-[0.5rem] border border-input bg-white pr-3 pl-9 text-sm shadow-[var(--shadow-input)] outline-none placeholder:text-slate focus-visible:border-rule-strong"
        />
      </form>
    </div>
  );
}
