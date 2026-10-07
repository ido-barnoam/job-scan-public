import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Job Scan",
  description: "Daily scan of Israeli tech job boards, judged by Jev",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
