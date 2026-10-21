import type { Metadata } from "next";
import { Suspense } from "react";
import { ProductsView } from "@/components/dashboard/products-view";

export const metadata: Metadata = { title: "Products" };

export default function ProductsPage() {
  return (
    <Suspense fallback={<div className="text-sm text-slate">Loading products…</div>}>
      <ProductsView />
    </Suspense>
  );
}
