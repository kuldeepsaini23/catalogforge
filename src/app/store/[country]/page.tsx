import type { Metadata } from "next";
import { Suspense } from "react";
import { cacheLife, cacheTag } from "next/cache";
import { COLLECTIONS_TAG } from "@/lib/revalidate";
import Link from "next/link";
import { ProductCard } from "@/components/store/product-card";
import { categoryName, getCollections, getFeatured, STORE_COPY } from "@/lib/storefront";
import { languageForCountry } from "@/lib/translate/locales";

export const metadata: Metadata = { title: "Storefront preview" };

export default function StoreHome({ params }: PageProps<"/store/[country]">) {
  return (
    <Suspense fallback={<GridSkeleton />}>
      {params.then(({ country }) => (
        <Home country={country} />
      ))}
    </Suspense>
  );
}

async function Home({ country }: { country: string }) {
  "use cache";
  cacheLife("storefront");
  cacheTag(COLLECTIONS_TAG);
  const locale = languageForCountry(decodeURIComponent(country));
  const t = STORE_COPY[locale];
  const [collections, featured] = await Promise.all([getCollections(), getFeatured(8)]);
  return (
    <div lang={locale}>
      <section className="py-10 md:py-14">
        <h1 className="font-[family-name:var(--font-store-heading)] text-3xl font-semibold tracking-tight md:text-5xl">{t.collections}</h1>
        {collections.length === 0 ? (
          <p className="mt-6 text-[#6b6b6e]">{t.empty}</p>
        ) : (
          <ul className="mt-8 grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 lg:grid-cols-4">
            {collections.map((c) => (
              <li key={c.slug}>
                <Link href={`/store/${country}/collections/${c.slug}`} className="group block">
                  <div className="aspect-square overflow-hidden rounded-lg bg-[#f4f4f5]">
                    {c.coverPhoto && (
                      // eslint-disable-next-line @next/next/no-img-element -- immutable photo route
                      <img src={`/api/photos/${c.coverPhoto}`} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
                    )}
                  </div>
                  <h2 className="mt-3 font-medium group-hover:underline">{categoryName(c.category, locale)}</h2>
                  <p className="text-sm text-[#6b6b6e]">
                    {c.count} {t.products}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      {featured.length > 0 && (
        <section className="border-t border-[#e5e5e5] pt-10">
          <h2 className="font-[family-name:var(--font-store-heading)] text-2xl font-semibold">{t.newIn}</h2>
          <ul className="mt-6 grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 lg:grid-cols-4">
            {featured.map((p, i) => (
              <ProductCard key={p.handle} product={p} country={country} locale={locale} priority={i < 4} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function GridSkeleton() {
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-8 py-10 md:grid-cols-3 lg:grid-cols-4" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <li key={i} className="aspect-[4/5] animate-pulse rounded-lg bg-[#f4f4f5]" />
      ))}
    </ul>
  );
}
