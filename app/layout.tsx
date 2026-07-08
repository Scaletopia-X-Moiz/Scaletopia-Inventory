import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import { InlineScript } from "@/components/shared/inline-script";
import { ToastContainer } from "@/components/shared/toast";
import { SessionProvider } from "@/components/dashboard/session-context";
import { getUser } from "@/lib/auth/dal";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Scaletopia Inventory",
  description: "Internal data visibility for Scaletopia's company and people store.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await getUser();
  const session = user ? { email: user.email, role: user.role } : null;

  return (
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={`${inter.variable} ${plexMono.variable} h-full antialiased`}
    >
      <head>
        <InlineScript
          html={`(function(){try{var t=localStorage.getItem("theme");if(!t)t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`}
        />
      </head>
      <body className="min-h-full bg-paper text-ink flex flex-col">
        <SessionProvider value={session}>{children}</SessionProvider>
        <ToastContainer />
      </body>
    </html>
  );
}
