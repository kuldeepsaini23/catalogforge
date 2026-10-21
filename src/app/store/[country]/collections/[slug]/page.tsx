import type { Metadata } from "next";
import { Suspense } from "react";
import { cacheLife, cacheTag } from "next/cache";
import { COLLECTIONS_TAG } from "@/lib/revalidate";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProductCard } from "@/components/store/product-card";
import { categoryName, getCollection, STORE_COPY } from "@/lib/storefront";
import { languageForCountry } from "@/lib/translate/locales";

export const metadata: Metadata = { title: "Collection" };

export default function CollectionPage({ params }: PageProps<"/store/[country]/collections/[slug]">) {
  return (
    <Suspense fallback={<div className="py-10 text-sm text-[#6b6b6e]">…</div>}>
      {params.then(({ country, slug }) => (
        <Collection country={country} slug={slug} />
      ))}
    </Suspense>
  );
}

/** Rendered collection cached per (country, slug); getCollection tags it with the collection tag. */
async function Collection({ country, slug }: { country: string; slug: string }) {
  "use cache";
  cacheLife("storefront");
  cacheTag(COLLECTIONS_TAG);
  const locale = languageForCountry(decodeURIComponent(country));
  const t = STORE_COPY[locale];
  const result = await getCollection(slug);
  if (!result) notFound();
  const { collection, products } = result;
  return (
    <div lang={locale} className="py-10">
      <nav aria-label="Breadcrumb" className="text-sm text-[#6b6b6e]">
        <Link href={`/store/${country}`} className="hover:underline">{t.back}</Link>
      </nav>
      <h1 className="mt-3 font-[family-name:var(--font-store-heading)] text-3xl font-semibold tracking-tight md:text-5xl">{categoryName(collection.category, locale)}</h1>
      <p className="mt-2 text-[#6b6b6e]">
        {collection.count} {t.products}
      </p>
      <ul className="mt-8 grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 lg:grid-cols-4">
        {products.map((p, i) => (
          <ProductCard key={p.handle} product={p} country={country} locale={locale} priority={i < 4} />
        ))}
      </ul>
    </div>
  );
}
