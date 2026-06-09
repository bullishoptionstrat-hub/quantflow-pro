'use client'
import { useStore } from '@/store/useStore'
import { formatPremium } from '@/lib/utils'

export function PowerAlertBanner() {
  const { powerAlerts, voiceEnabled, setVoiceEnabled } = useStore()
  const recent = powerAlerts.filter(a => Date.now() - new Date(a.created_at).getTime() < 300_000)

  if (recent.length === 0) return null

  return (
    <div className="power-banner">
      <span style={{ color: '#f97316', fontWeight: 700, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>
        ⚡ POWER ALERTS {recent.length}
      </span>
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', gap: 24, maskImage: 'linear-gradient(90deg,transparent,black 20px,black calc(100% - 20px),transparent)' }}>
        {recent.slice(0, 6).map(a => (
          <span key={a.id} style={{ whiteSpace: 'nowrap', fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: '#fafafa' }}>
            <span style={{ color: a.heat_score >= 80 ? '#fbbf24' : '#fb923c', fontWeight: 700 }}>{a.underlying}</span>
            {' · '}{a.message.split('—')[1]?.trim() || a.message}
            {' · '}<span style={{ color: '#a78bfa' }}>HEAT {a.heat_score}</span>
          </span>
        ))}
      </div>
      <button
        onClick={() => setVoiceEnabled(!voiceEnabled)}
        style={{ background: 'transparent', border: '1px solid var(--border-light)', borderRadius: 4, color: voiceEnabled ? '#fbbf24' : 'var(--text-muted)', fontSize: 12, padding: '2px 8px', cursor: 'pointer', flexShrink: 0, fontFamily: "'JetBrains Mono', monospace' " }}
      >
        {voiceEnabled ? '🔊 VOICE ON' : '🔇 VOICE OFF'}
      </button>
    </div>
  )
}
