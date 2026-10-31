import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "WebhookLab",
  description: "A webhook processing simulator: receive, process, retry and record payment events.",
};

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/events", label: "Events" },
  { href: "/wallets", label: "Wallets" },
  { href: "/simulate", label: "Simulate" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen">
          <header className="border-b border-ink-700/70 bg-ink-900/70 backdrop-blur">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-8 gap-y-3 px-6 py-4">
              <Link href="/" className="flex items-center gap-2">
                <span className="grid h-8 w-8 place-items-center rounded-md bg-sky-600 font-mono text-sm font-bold text-white">
                  W
                </span>
                <span className="text-base font-semibold tracking-tight text-white">WebhookLab</span>
              </Link>

              <nav className="flex flex-wrap items-center gap-1 text-sm">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="rounded-md px-3 py-1.5 text-slate-300 transition hover:bg-ink-800 hover:text-white"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>

              <span className="ml-auto font-mono text-xs text-slate-500">
                POST /api/webhooks/payments
              </span>
            </div>
          </header>

          <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>

          <footer className="mx-auto max-w-7xl px-6 pb-10 pt-4 text-xs text-slate-500">
            WebhookLab - a simulator for receiving, processing, retrying and recording payment webhooks.
          </footer>
        </div>
      </body>
    </html>
  );
}