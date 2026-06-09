import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatPremium(val: number): string {
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`
  if (val >= 1_000) return `$${Math.round(val / 1_000)}K`
  return `$${val}`
}

export function formatNumber(val: number): string {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}K`
  return val.toString()
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'America/New_York' })
}

export function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function formatExpiry(expiry: string): string {
  // expiry: "2026-05-01" → "May 1"
  const d = new Date(expiry + 'T12:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function isMarketOpen(): boolean {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const d = et.getDay()
  const t = et.getHours() * 60 + et.getMinutes()
  return d >= 1 && d <= 5 && t >= 570 && t < 960 // 9:30 AM – 4:00 PM ET
}

export function heatColor(score: number): string {
  if (score >= 75) return '#fbbf24'  // fire
  if (score >= 65) return '#f97316'  // hot
  if (score >= 40) return '#3b82f6'  // warm
  return '#6b7280'                    // cold
}

export function heatBg(score: number): string {
  if (score >= 75) return 'rgba(251,191,36,0.15)'
  if (score >= 65) return 'rgba(249,115,22,0.15)'
  if (score >= 40) return 'rgba(59,130,246,0.15)'
  return 'rgba(107,114,128,0.15)'
}

export function sentimentColor(s: string): string {
  if (s === 'BULLISH') return '#22c55e'
  if (s === 'BEARISH') return '#ef4444'
  return '#a1a1aa'
}

export function sentimentBg(s: string): string {
  if (s === 'BULLISH') return 'rgba(34,197,94,0.12)'
  if (s === 'BEARISH') return 'rgba(239,68,68,0.12)'
  return 'rgba(161,161,170,0.12)'
}

// Generate realistic seed flow events for demo
export function generateSeedFlow(count = 50): import('./types').FlowEvent[] {
  const tickers = ['NVDA','SPX','SPY','QQQ','MSTR','MSFT','MU','MRVL','AAPL','TSLA','META','AMD','AMZN','GOOGL','SOXL','IWM','XLF','GLD','ARKK']
  const sentiments: Array<'BULLISH'|'BEARISH'|'NEUTRAL'> = ['BULLISH','BULLISH','BULLISH','BEARISH','BEARISH','NEUTRAL']
  const orderTypes: Array<'SWEEP'|'BLOCK'|'SPLIT'> = ['SWEEP','SWEEP','BLOCK','BLOCK','SPLIT']
  const now = Date.now()
  return Array.from({ length: count }, (_, i) => {
    const ticker = tickers[Math.floor(Math.random() * tickers.length)]
    const isCall = Math.random() > 0.4
    const heat = Math.floor(Math.random() * 60 + 40)
    const premium = Math.floor(Math.random() * 15_000_000 + 500_000)
    const orderType = orderTypes[Math.floor(Math.random() * orderTypes.length)]
    const sent = sentiments[Math.floor(Math.random() * sentiments.length)]
    const spot = ticker === 'SPX' ? 5587 : ticker === 'NVDA' ? 942 : ticker === 'SPY' ? 557 : ticker === 'QQQ' ? 472 : Math.floor(Math.random() * 200 + 50)
    const strike = Math.round(spot * (0.85 + Math.random() * 0.3) / 5) * 5
    const daysOut = [8, 15, 22, 29, 45, 60][Math.floor(Math.random() * 6)]
    const expiry = new Date(now + daysOut * 86400000).toISOString().slice(0, 10)
    return {
      id: `seed-${i}-${Date.now()}`,
      underlying: ticker,
      expiry,
      strike,
      option_type: isCall ? 'C' : 'P',
      order_type: orderType,
      total_size: Math.floor(Math.random() * 5000 + 200),
      total_premium: premium,
      heat_score: heat,
      sentiment: sent,
      is_unusual: heat >= 75 || orderType === 'SWEEP',
      exchange_count: Math.floor(Math.random() * 5 + 1),
      avg_price: parseFloat((premium / (Math.floor(Math.random() * 5000 + 200) * 100)).toFixed(2)),
      iv: parseFloat((Math.random() * 60 + 15).toFixed(1)),
      delta: parseFloat(((isCall ? 1 : -1) * (Math.random() * 0.5 + 0.2)).toFixed(3)),
      open_interest: Math.floor(Math.random() * 80000 + 5000),
      days_to_expiry: daysOut,
      moneyness: Math.abs(strike - spot) / spot < 0.01 ? 'ATM' : strike > spot ? 'OTM' : 'ITM',
      spot_price: spot,
      created_at: new Date(now - i * 35000).toISOString(),
      source: 'seed',
    }
  })
}
