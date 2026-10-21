import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";

export function PageBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex w-full flex-col gap-6 px-4 py-5 md:px-6 md:py-8", className)}>{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
  badges,
  back,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  badges?: React.ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="flex flex-col gap-2">
      {back && (
        <Link href={back.href} className="inline-flex w-fit items-center gap-1 text-sm text-slate hover:text-ink">
          <ChevronLeft className="size-4" aria-hidden />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[1.75rem] leading-9 font-semibold tracking-[-0.02em] text-ink">{title}</h1>
            {badges}
          </div>
          {description && <p className="mt-1 max-w-2xl text-sm text-slate">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function Card({ children, className, ...rest }: React.HTMLAttributes<HTMLElement> & { children: React.ReactNode }) {
  return (
    <section className={cn("overflow-hidden rounded-xl surface-card", className)} {...rest}>
      {children}
    </section>
  );
}

/** Floating glass pill for bulk actions / unsaved changes. */
export function FloatingBar({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div role="region" aria-label={label} className="fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
      <div className="flex max-w-full flex-wrap items-center gap-2 rounded-full glass-bar py-1.5 pr-1.5 pl-4 text-sm">{children}</div>
    </div>
  );
}
