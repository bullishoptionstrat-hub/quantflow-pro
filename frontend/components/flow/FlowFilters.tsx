'use client'
import { useStore } from '@/store/useStore'
import type { FlowFilters as Filters } from '@/lib/types'

/**
 * The option lists are typed against `FlowFilters`, and the casts are gone.
 *
 * These were `string[][]`, and each `onChange` narrowed `e.target.value` with
 * `as any`. So nothing checked a list against the union it feeds: an order
 * type added to the engine and not to `ORDER_TYPES` is invisible, and — worse
 * — a typo in a list writes a value no signal can ever match into the store,
 * and the feed silently goes empty with the control showing a plausible label.
 *
 * Same hazard as `PowerAlert.alert_type`, where `event.order_type as any` was
 * the only reason a union missing SPLIT, MULTI_LEG and LARGE compiled. A cast
 * over a value crossing between two type systems is where these hide.
 */
type Choice<T> = readonly [value: T, label: string]

const OPTION_TYPES: readonly Choice<Filters['optionType']>[] = [
  ['ALL', 'All Types'], ['C', 'CALLS'], ['P', 'PUTS'],
]
const ORDER_TYPES: readonly Choice<Filters['orderType']>[] = [
  ['ALL', 'All Orders'], ['SWEEP', 'SWEEP'], ['BLOCK', 'BLOCK'],
  ['SPLIT', 'SPLIT'], ['MULTI_LEG', 'MULTI-LEG'], ['LARGE', 'LARGE'],
]
const SENTIMENTS: readonly Choice<Filters['sentiment']>[] = [
  ['ALL', 'All Sentiment'], ['BULLISH', 'BULLISH'], ['BEARISH', 'BEARISH'], ['NEUTRAL', 'NEUTRAL'],
]
const HEAT_LEVELS: readonly Choice<number>[] = [
  [0, 'All Heat'], [40, '40+ Warm'], [65, '65+ Hot'], [75, '75+ 🔥 Fire'],
]
const PREMIUM_LEVELS: readonly Choice<number>[] = [
  [25000, '$25K+'], [100000, '$100K+'], [500000, '$500K+'],
  [1000000, '$1M+'], [5000000, '$5M+'], [10000000, '$10M+'],
]

const selectStyle: React.CSSProperties = {
  background: 'var(--bg-secondary)', border: '1px solid var(--border-light)',
  color: 'var(--text-primary)', borderRadius: 5, padding: '5px 8px',
  fontSize: 11, fontFamily: "'Inter', sans-serif", cursor: 'pointer', outline: 'none',
}

export function FlowFilters() {
  const { filters, setFilters, resetFilters } = useStore()

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 0', alignItems: 'center' }}>
      {/* Ticker search */}
      <input
        type="text"
        placeholder="Ticker…"
        value={filters.ticker}
        onChange={e => setFilters({ ticker: e.target.value.toUpperCase() })}
        style={{ ...selectStyle, width: 90, padding: '5px 10px' }}
      />

      {/* Option type */}
      <select value={filters.optionType} onChange={e => setFilters({ optionType: e.target.value as Filters['optionType'] })} style={selectStyle}>
        {OPTION_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>

      {/* Order type */}
      <select value={filters.orderType} onChange={e => setFilters({ orderType: e.target.value as Filters['orderType'] })} style={selectStyle}>
        {ORDER_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>

      {/* Sentiment */}
      <select value={filters.sentiment} onChange={e => setFilters({ sentiment: e.target.value as Filters['sentiment'] })} style={selectStyle}>
        {SENTIMENTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>

      {/* Min premium */}
      <select value={filters.minPremium} onChange={e => setFilters({ minPremium: Number(e.target.value) })} style={selectStyle}>
        {PREMIUM_LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>

      {/* Heat filter */}
      <select value={filters.minHeat} onChange={e => setFilters({ minHeat: Number(e.target.value) })} style={selectStyle}>
        {HEAT_LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>

      {/* Unusual only */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: filters.unusualOnly ? '#fbbf24' : 'var(--text-secondary)', fontSize: 11, cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace" }}>
        <input
          type="checkbox"
          checked={filters.unusualOnly}
          onChange={e => setFilters({ unusualOnly: e.target.checked })}
          style={{ accentColor: '#fbbf24' }}
        />
        Unusual Only
      </label>

      {/* Reset */}
      <button onClick={resetFilters} style={{ ...selectStyle, color: '#a78bfa', borderColor: 'rgba(139,92,246,0.3)', background: 'rgba(139,92,246,0.08)' }}>
        ↺ Reset
      </button>
    </div>
  )
}
