'use client'
import './globals.css'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { MobileNav } from '@/components/layout/MobileNav'
import { PowerAlertBanner } from '@/components/alerts/PowerAlertBanner'
import { DemoBanner } from '@/components/layout/DemoBanner'
import { StatusStrip } from '@/components/hud/StatusStrip'
import { CommandPalette } from '@/components/hud/CommandPalette'
import { MarketSessionProvider } from '@/lib/marketSession'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <title>QuantFlow Pro — Institutional Options Intelligence</title>
        {/* "Real-time … AI power alerts": the tape is whatever the backend
            sends, GEX is delayed, and there is no model — alerts are a
            deterministic score crossing a published threshold. */}
        <meta name="description" content="Options flow, dark pool prints, modelled GEX and rule-based power alerts, each labelled with its source." />
        <link rel="icon" href="/favicon.ico" />
        <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        {/* One /api/health poll for the sidebar, the status strip and the
            trade ticket, so they cannot show two verdicts at 09:30. */}
        <MarketSessionProvider>
          <div className="main-layout">
            <Sidebar />
            <div className="main-content">
              <DemoBanner />
              <div className="hud-header">
                <StatusStrip />
                <TopBar />
              </div>
              <PowerAlertBanner />
              <main className="page-content">
                {children}
              </main>
              <footer className="text-center py-3 border-t border-[var(--border)] text-[var(--text-muted)] text-xs">
                Not investment advice. QuantFlow Pro is a data visualization tool only. Options trading involves substantial risk of loss.
              </footer>
            </div>
            <MobileNav />
          </div>
          <CommandPalette />
        </MarketSessionProvider>
      </body>
    </html>
  )
}
