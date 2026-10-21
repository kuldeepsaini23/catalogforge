import type { Metadata } from "next";
import { MetricsView } from "@/components/dashboard/metrics-view";

export const metadata: Metadata = { title: "Metrics" };

export default function MetricsPage() {
  return <MetricsView />;
}
