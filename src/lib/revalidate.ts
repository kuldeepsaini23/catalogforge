import { revalidateTag } from "next/cache";
import { slugify } from "@/lib/cleaning/text";

export const productTag = (handle: string) => `product:${handle}`;
export const collectionTag = (category: string) => `collection:${slugify(category)}`;
export const COLLECTIONS_TAG = "collections";

/** Expires storefront cache entries for changed products and their collections (next visit refetches). */
export function revalidateStorefront(handles: string[], categories: string[]): void {
  for (const h of handles) revalidateTag(productTag(h), { expire: 0 });
  for (const c of new Set(categories)) revalidateTag(collectionTag(c), { expire: 0 });
  if (handles.length || categories.length) revalidateTag(COLLECTIONS_TAG, { expire: 0 });
}
