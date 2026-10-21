import type { Metadata } from "next";
import { Suspense } from "react";
import { cacheLife, cacheTag } from "next/cache";
import { productTag } from "@/lib/revalidate";
import Link from "next/link";
import { LOCALE_TAG } from "@/components/store/product-card";
import { money } from "@/lib/format";
import { ATTRIBUTE_LABELS, categoryName, getProduct, localized, OPTION_LABELS, STORE_COPY } from "@/lib/storefront";
import { slugify } from "@/lib/cleaning/text";
import { languageForCountry } from "@/lib/translate/locales";

export const metadata: Metadata = { title: "Product" };

export default function ProductPage({ params }: PageProps<"/store/[country]/products/[handle]">) {
  return (
    <Suspense fallback={<div className="py-10 text-sm text-[#6b6b6e]">…</div>}>
      {params.then(({ country, handle }) => (
        <Product country={country} handle={handle} />
      ))}
    </Suspense>
  );
}

/** The rendered page is cached per (country, handle) and tagged, so a view replays it instead of re-rendering. */
async function Product({ country, handle }: { country: string; handle: string }) {
  "use cache";
  cacheLife("storefront");
  cacheTag(productTag(handle));
  const locale = languageForCountry(decodeURIComponent(country));
  const t = STORE_COPY[locale];
  const product = await getProduct(handle);
  if (!product) {
    return (
      <div className="py-20 text-center">
        <p className="text-lg">{t.notFound}</p>
        <Link href={`/store/${country}`} className="mt-4 inline-block underline">{t.back}</Link>
      </div>
    );
  }
  const copy = localized(product, locale);
  const labels = ATTRIBUTE_LABELS[locale];
  const optionNames = [...new Set(product.data.variants.flatMap((v) => Object.keys(v.options)))];
  const priced = product.data.variants.filter((v) => v.priceCents !== null);

  return (
    <div lang={locale} className="flex flex-col gap-8 py-8 lg:flex-row lg:gap-12 lg:py-12">
      <div className="lg:sticky lg:top-6 lg:flex-[0_0_55%] lg:self-start">
        <div className="grid gap-3 sm:grid-cols-2">
          {product.data.photos.length ? (
            product.data.photos.map((id, i) => (
              // eslint-disable-next-line @next/next/no-img-element -- immutable photo route
              <img key={id} src={`/api/photos/${id}`} alt={i === 0 ? copy.title : ""} loading={i === 0 ? "eager" : "lazy"} className={`w-full rounded-lg bg-[#f4f4f5] object-cover ${i === 0 ? "aspect-[4/3] sm:col-span-2 lg:aspect-square" : "aspect-square"}`} />
            ))
          ) : (
            <div className="aspect-square rounded-lg bg-[#f4f4f5] sm:col-span-2" />
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <nav aria-label="Breadcrumb" className="text-sm text-[#6b6b6e]">
          <Link href={`/store/${country}/collections/${slugify(product.category)}`} className="hover:underline">
            {categoryName(product.category, locale)}
          </Link>
        </nav>
        <h1 className="mt-2 font-[family-name:var(--font-store-heading)] text-3xl leading-tight font-semibold tracking-tight md:text-4xl">{copy.title}</h1>
        <p className="mt-3 text-xl">
          {product.priceMinCents === null ? t.unavailable : `${priced.length > 1 && new Set(priced.map((v) => v.priceCents)).size > 1 ? `${t.from} ` : ""}${money(product.priceMinCents, product.currency, LOCALE_TAG[locale])}`}
        </p>

        {optionNames.length > 0 && (
          <div className="mt-6 grid gap-4">
            {optionNames.map((name) => (
              <fieldset key={name}>
                <legend className="text-sm font-medium">{OPTION_LABELS[locale][name] ?? name}</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {[...new Set(product.data.variants.map((v) => v.options[name]).filter(Boolean))].map((value) => (
                    <span key={value} className="rounded-full border border-[#e5e5e5] px-3.5 py-1.5 text-sm">{value}</span>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        )}

        <button type="button" className="mt-8 h-12 w-full rounded-full bg-[#6c3baa] px-6 font-medium text-white transition-opacity hover:opacity-90 md:w-auto md:min-w-64">
          {t.addToCart}
        </button>

        <div className="mt-10 border-t border-[#e5e5e5] pt-6 text-[0.9375rem] leading-relaxed [&_li]:ml-5 [&_li]:list-disc [&_p]:mb-3 [&_ul]:mb-3" dangerouslySetInnerHTML={{ __html: copy.descriptionHtml }} />

        {Object.keys(product.data.attributes).length > 0 && (
          <section className="mt-6 border-t border-[#e5e5e5] pt-6">
            <h2 className="font-[family-name:var(--font-store-heading)] text-lg font-semibold">{t.details}</h2>
            <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
              {Object.entries(product.data.attributes).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-[#6b6b6e]">{labels[k] ?? k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        <section className="mt-6 border-t border-[#e5e5e5] pt-6">
          <h2 className="font-[family-name:var(--font-store-heading)] text-lg font-semibold">{t.variants}</h2>
          <ul className="mt-3 divide-y divide-[#e5e5e5] text-sm">
            {product.data.variants.map((v) => (
              <li key={v.sku} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <span>{Object.values(v.options).join(" / ") || "—"}</span>
                <span className="text-[#6b6b6e]">{t.sku} {v.sku}</span>
                <span className="tabular-nums">{v.priceCents === null ? t.unavailable : money(v.priceCents, v.currency, LOCALE_TAG[locale])}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
