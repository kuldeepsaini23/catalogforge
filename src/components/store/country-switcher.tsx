"use client";

import { usePathname, useRouter } from "next/navigation";
import { COUNTRIES, languageForCountry } from "@/lib/translate/locales";

/** Switches the visitor's country (and with it the language) on the current page. */
export function CountrySwitcher() {
  const pathname = usePathname();
  const router = useRouter();
  const [, , current = "US", ...rest] = pathname.split("/");
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">Country</span>
      <select
        value={COUNTRIES.find((c) => c.code.toLowerCase() === decodeURIComponent(current).toLowerCase())?.code ?? "US"}
        onChange={(e) => router.push(`/store/${e.target.value}${rest.length ? `/${rest.join("/")}` : ""}`)}
        className="h-9 rounded-md border border-[#e5e5e5] bg-white px-2 text-sm"
      >
        {COUNTRIES.map((c) => (
          <option key={c.code} value={c.code}>
            {c.label} ({languageForCountry(c.code).toUpperCase()})
          </option>
        ))}
      </select>
    </label>
  );
}
