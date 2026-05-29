import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./styles/globals.css";
import { WalletProvider } from "./components/WalletProvider";
import { ConnectWallet } from "./components/ConnectWallet";
import { NotificationProvider } from "./context/NotificationContext";

export const metadata: Metadata = {
  title: "Linkora Web",
  description: "Web frontend scaffold for Linkora Social",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <NotificationProvider>
          <WalletProvider>
            <nav style={navStyles}>
              <div style={navContainer}>
                <a href="/" style={logo}>Linkora</a>
                <div style={navLinks}>
                  <a href="/feed" style={navLink}>Feed</a>
                  <a href="/explore" style={navLink}>Explore</a>
                  <a href="/pools" style={navLink}>Pools</a>
                  <ConnectWallet />
                </div>
              </div>
            </nav>
            {children}
          </WalletProvider>
        </NotificationProvider>
      </body>
    </html>
  );
}