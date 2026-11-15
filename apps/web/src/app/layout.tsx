import type { Metadata } from "next";
import Link from "next/link";
import { LogoutButton } from "@/components/json-form";
import { currentAccount } from "@/lib/server-auth";
import "./styles.css";

export const metadata: Metadata = {
  title: "Live Competition Engine",
  description: "Domain-neutral infrastructure for live competitions."
};

export default async function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  const account = await currentAccount().catch(() => null);
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <header className="topbar">
          <Link href="/" className="brand">Live Competition Engine</Link>
          <nav aria-label="Account">
            {account ? (
              <>
                <Link href="/dashboard">Dashboard</Link>
                <LogoutButton />
              </>
            ) : (
              <>
                <Link href="/login">Sign in</Link>
                <Link href="/signup">Sign up</Link>
              </>
            )}
          </nav>
        </header>
        <div id="main">{children}</div>
      </body>
    </html>
  );
}
