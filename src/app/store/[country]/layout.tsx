import type { Metadata } from "next";
import { Suspense } from "react";
import { Archivo, Figtree } from "next/font/google";
import Link from "next/link";
import { CountrySwitcher } from "@/components/store/country-switcher";
import { COUNTRIES } from "@/lib/translate/locales";

const archivo = Archivo({ variable: "--font-store-heading", subsets: ["latin", "latin-ext"] });
const figtree = Figtree({ variable: "--font-store-body", subsets: ["latin", "latin-ext"] });

// Shop pages carry their own titles, not the dashboard's "· CatalogForge" suffix.
export const metadata: Metadata = { title: { default: "Shop", template: "%s" } };

export function generateStaticParams() {
  return COUNTRIES.map((c) => ({ country: c.code }));
}

export default function StoreLayout({ children, params }: LayoutProps<"/store/[country]">) {
  return (
    <div className={`${archivo.variable} ${figtree.variable} store min-h-dvh bg-white font-[family-name:var(--font-store-body)] text-[#1f1f21]`}>
      <div className="bg-[#1f1f21] px-4 py-2 text-center text-xs text-white/80">
        Storefront preview: only published products appear, read from the published snapshot.{" "}
        <Link href="/products" className="underline underline-offset-2 hover:text-white">Back to the dashboard</Link>
      </div>
      <header className="border-b border-[#e5e5e5]">
        <div className="mx-auto flex max-w-[1440px] items-center gap-4 px-4 py-4 md:px-8">
          <Suspense fallback={<span className="font-[family-name:var(--font-store-heading)] text-xl font-semibold">Hearth &amp; Field</span>}>
            <HomeLink params={params} />
          </Suspense>
          <div className="ml-auto">
            <Suspense fallback={null}>
              <CountrySwitcher />
            </Suspense>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1440px] px-4 pb-16 md:px-8">{children}</main>
    </div>
  );
}

async function HomeLink({ params }: { params: Promise<{ country: string }> }) {
  const { country } = await params;
  return (
    <Link href={`/store/${country}`} className="font-[family-name:var(--font-store-heading)] text-xl font-semibold tracking-tight">
      Hearth &amp; Field
    </Link>
  );
}
