import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ToastProvider } from "@/components/client";
import { ServiceWorkerRegistration } from "@/components/sw-register";

export const metadata: Metadata = {
  title: { default: "Stockline", template: "%s · Stockline" },
  description: "Restaurant inventory and food-cost operating system",
  manifest: "/manifest.webmanifest",
  applicationName: "Stockline",
  appleWebApp: { capable: true, title: "Stockline", statusBarStyle: "default" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#0f6e66" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1116" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <ToastProvider>{children}</ToastProvider>
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
