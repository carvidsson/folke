import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Folke",
    template: "%s · Folke",
  },
  description: "Folke – intern AI-plattform för Börjessons medarbetare.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Reading request headers renders every page per request, so Next.js can
  // attach the CSP nonce (set in src/proxy.ts) to its scripts.
  await headers();
  return (
    <html lang="sv" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
