import Link from "next/link";
import { money } from "@/lib/format";
import { localized, STORE_COPY, type StoreProduct } from "@/lib/storefront";
import type { Locale } from "@/lib/translate/locales";

export const LOCALE_TAG: Record<Locale, string> = { en: "en-GB", de: "de-DE", fr: "fr-FR" };

export function ProductCard({ product, country, locale, priority }: { product: StoreProduct; country: string; locale: Locale; priority?: boolean }) {
  const copy = localized(product, locale);
  const photo = product.data.photos[0];
  return (
    <li>
      <Link href={`/store/${country}/products/${product.handle}`} className="group block">
        <div className="aspect-[4/5] overflow-hidden rounded-lg bg-[#f4f4f5]">
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element -- immutable photo route
            <img src={`/api/photos/${photo}`} alt="" loading={priority ? "eager" : "lazy"} className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
          ) : (
            <div className="grid h-full place-items-center text-xs text-[#6b6b6e]">{copy.title}</div>
          )}
        </div>
        <h3 className="mt-3 text-[0.9375rem] leading-snug font-medium group-hover:underline">{copy.title}</h3>
        <p className="mt-1 text-sm text-[#6b6b6e]">
          {product.priceMinCents === null ? STORE_COPY[locale].unavailable : `${product.data.variants.length > 1 ? `${STORE_COPY[locale].from} ` : ""}${money(product.priceMinCents, product.currency, LOCALE_TAG[locale])}`}
        </p>
      </Link>
    </li>
  );
}
