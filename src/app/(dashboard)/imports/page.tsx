import type { Metadata } from "next";
import { ImportsView } from "@/components/dashboard/imports-view";

export const metadata: Metadata = { title: "Imports" };

export default function ImportsPage() {
  return <ImportsView />;
}
