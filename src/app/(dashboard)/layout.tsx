import { Suspense } from "react";
import Link from "next/link";
import { DashboardNav, NavLinks } from "@/components/dashboard/nav";
import { TopBar } from "@/components/dashboard/top-bar";

/** Grey shell (sidebar + top bar) wrapping one white, rounded content panel. */
export default function DashboardLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-dvh flex-col bg-sidebar md:flex-row">
      <aside className="flex shrink-0 flex-col md:sticky md:top-0 md:h-dvh md:w-64">
        <div className="flex h-14 items-center px-4">
          <Link href="/imports" className="flex items-center gap-2.5 font-semibold tracking-tight text-ink">
            <span className="grid size-7 place-items-center rounded-[0.5rem] key-primary text-white">
              <svg viewBox="0 0 20 20" className="size-4" aria-hidden>
                <path d="M4 6.5 10 3l6 3.5v7L10 17l-6-3.5z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                <path d="M4 6.5 10 10l6-3.5M10 10v7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              </svg>
            </span>
            CatalogForge
          </Link>
        </div>
        <div className="overflow-x-auto px-2 pb-2 md:flex-1 md:px-3">
          <Suspense fallback={<NavLinks pathname="" />}>
            <DashboardNav />
          </Suspense>
        </div>
        <p className="hidden px-5 pb-5 text-xs leading-relaxed text-slate md:block">
          Supplier sheets in, clean EN/DE/FR catalog out. Every claim cites its source row.
        </p>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-w-0 flex-1 bg-background md:rounded-tl-xl md:border-t md:border-l md:border-rule">{children}</main>
      </div>
    </div>
  );
}
