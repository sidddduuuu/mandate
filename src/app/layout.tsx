import type { ReactNode } from "react";
import { Cormorant_Garamond, Outfit } from "next/font/google";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { auth0 } from "./auth0-page";
import "./globals.css";

const display = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

const sans = Outfit({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata = {
  title: "Mandate — Governed commerce for AI agents",
  description:
    "Give every buying agent a verifiable purchasing mandate—scoped budgets, suppliers, and human approval.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await auth0.getSessionSafe();
  const orgHint = process.env.SEED_BUYER_AUTH0_ORG_ID ?? "org_buyer";

  return (
    <html lang="en" className={`${display.variable} ${sans.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <SiteHeader
          signedIn={Boolean(session?.user)}
          email={session?.user?.email ?? session?.user?.sub ?? null}
          orgId={session?.user?.org_id ?? null}
          orgHint={orgHint}
        />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
