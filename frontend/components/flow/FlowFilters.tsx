'use client'
import { useStore } from '@/store/useStore'

const OPTION_TYPES = [['ALL', 'All Types'], ['C', 'CALLS'], ['P', 'PUTS']]
const ORDER_TYPES = [['ALL', 'All Orders'], ['SWEEP', 'SWEEP'], ['BLOCK', 'BLOCK'], ['SPLIT', 'SPLIT']]
const SENTIMENTS = [['ALL', 'All Sentiment'], ['BULLISH', 'BULLISH'], ['BEARISH', 'BEARISH'], ['NEUTRAL', 'NEUTRAL']]
const HEAT_LEVELS = [[0, 'All Heat'], [40, '40+ Warm'], [65, '65+ Hot'], [75, '75+ 🔥 Fire']]
const PREMIUM_LEVELS = [[25000, '$25K+'], [100000, '$100K+'], [500000, '$500K+'], [1000000, '$1M+'], [5000000, '$5M+'], [10000000, '$10M+']]

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
      <select value={filters.optionType} onChange={e => setFilters({ optionType: e.target.value as any })} style={selectStyle}>
        {OPTION_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>

      {/* Order type */}
      <select value={filters.orderType} onChange={e => setFilters({ orderType: e.target.value as any })} style={selectStyle}>
        {ORDER_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>

      {/* Sentiment */}
      <select value={filters.sentiment} onChange={e => setFilters({ sentiment: e.target.value as any })} style={selectStyle}>
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
