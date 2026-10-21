import type { Metadata } from "next";
import { Suspense } from "react";
import { ProductDetailView } from "@/components/dashboard/product-detail";

export const metadata: Metadata = { title: "Review product" };

export default function ProductPage({ params }: PageProps<"/products/[id]">) {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate">Loading product…</div>}>
      <Detail params={params} />
    </Suspense>
  );
}

async function Detail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProductDetailView id={id} />;
}
