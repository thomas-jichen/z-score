import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Z-Score",
  description:
    "Every credential weighted by hand and added up. Early talent, surfaced and ranked.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* Extensions (Bitdefender, Grammarly, LastPass) stamp attributes onto
          <body> before React hydrates, which reads as a hydration mismatch.
          Suppressing here covers the body's own attributes; nested elements
          they touch still warn, and that is not worth contorting the tree for. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
