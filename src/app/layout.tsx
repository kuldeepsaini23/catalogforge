import type { Metadata } from "next";
import { Geist_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const jakarta = Plus_Jakarta_Sans({ variable: "--font-jakarta", subsets: ["latin", "latin-ext"] });
const mono = Geist_Mono({ variable: "--font-mono-code", subsets: ["latin"] });

export const metadata: Metadata = {
  // Absolute URLs for canonical, hreflang and Open Graph links.
  metadataBase: new URL(process.env.PUBLIC_BASE_URL || "http://localhost:3000"),
  title: { default: "CatalogForge", template: "%s · CatalogForge" },
  description: "Turn messy supplier sheets and photos into a clean, multi-language product catalog.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${jakarta.variable} ${mono.variable} h-full antialiased`}>
      <body className="min-h-full bg-background text-foreground">
        <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
