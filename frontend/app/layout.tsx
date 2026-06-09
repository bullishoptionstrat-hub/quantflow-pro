'use client'
import './globals.css'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { MobileNav } from '@/components/layout/MobileNav'
import { PowerAlertBanner } from '@/components/alerts/PowerAlertBanner'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <title>QuantFlow Pro — Institutional Options Intelligence</title>
        <meta name="description" content="Real-time options flow, dark pool prints, GEX, and AI power alerts for institutional traders." />
        <link rel="icon" href="/favicon.ico" />
        <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        <div className="main-layout">
          <Sidebar />
          <div className="main-content">
            <TopBar />
            <PowerAlertBanner />
            <div className="page-content">
              {children}
            </div>
            <footer className="text-center py-3 border-t border-[var(--border)] text-[var(--text-muted)] text-xs">
              Not investment advice. QuantFlow Pro is a data visualization tool only. Options trading involves substantial risk of loss.
            </footer>
          </div>
          <MobileNav />
        </div>
      </body>
    </html>
  )
}
