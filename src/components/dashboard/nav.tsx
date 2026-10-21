"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Package, Store, Upload } from "lucide-react";
import { cn } from "@/lib/utils";

const GROUPS = [
  {
    label: "Catalog",
    links: [
      { href: "/imports", label: "Imports", icon: Upload },
      { href: "/products", label: "Products", icon: Package },
      { href: "/metrics", label: "Metrics", icon: BarChart3 },
    ],
  },
  { label: "Sales channels", links: [{ href: "/store/DE", label: "Storefront preview", icon: Store }] },
] as const;

export function DashboardNav() {
  return <NavLinks pathname={usePathname()} />;
}

/** Plain links; also rendered (without an active item) as the Suspense fallback. */
export function NavLinks({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="Main" className="flex gap-4 md:flex-col md:gap-0">
      {GROUPS.map((g) => (
        <div key={g.label} className="flex gap-1 md:block">
          <p className="hidden px-2 pt-3.5 pb-1.5 text-xs font-medium text-slate md:block">{g.label}</p>
          <ul className="flex gap-1 md:flex-col md:gap-0.5">
            {g.links.map(({ href, label, icon: Icon }) => {
              const active = pathname !== "" && (href.startsWith("/store") ? pathname.startsWith("/store") : pathname.startsWith(href));
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex h-8 items-center gap-2 rounded-[0.375rem] px-2 text-sm whitespace-nowrap text-ink/80 transition-colors hover:bg-sidebar-accent/70",
                      active && "bg-sidebar-accent font-medium text-ink before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-ink",
                    )}
                  >
                    <Icon className="size-4" strokeWidth={1.6} aria-hidden />
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
