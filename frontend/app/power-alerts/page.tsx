'use client'
import { useStore } from '@/store/useStore'
import { formatTime, formatPremium, heatColor } from '@/lib/utils'
import { HeatBadge } from '@/components/ui/HeatBadge'

const ALERT_TYPE_COLORS: Record<string, string> = {
  SWEEP: '#8b5cf6', BLOCK: '#3b82f6', DARK_POOL: '#fbbf24', GEX_FLIP: '#f97316', ML_SIGNAL: '#22c55e',
}

export default function PowerAlertsPage() {
  const { powerAlerts, voiceEnabled, setVoiceEnabled } = useStore()

  const requestNotifications = async () => {
    if (typeof Notification !== 'undefined') {
      await Notification.requestPermission()
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: '#fafafa', marginBottom: 4 }}>🔥 Power Alerts</h1>
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>AI-scored unusual activity · Heat ≥75 · SWEEP + Block alerts · Voice + push notifications</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setVoiceEnabled(!voiceEnabled)}
            style={{ background: voiceEnabled ? 'rgba(251,191,36,0.1)' : 'var(--bg-secondary)', border: `1px solid ${voiceEnabled ? 'rgba(251,191,36,0.4)' : 'var(--border)'}`, color: voiceEnabled ? '#fbbf24' : 'var(--text-secondary)', padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}
          >
            {voiceEnabled ? '🔊 VOICE ON' : '🔇 VOICE OFF'}
          </button>
          <button
            onClick={requestNotifications}
            style={{ background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.3)', color: '#a78bfa', padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}
          >
            🔔 Enable Push
          </button>
        </div>
      </div>

      {powerAlerts.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🔥</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: 14 }}>No power alerts yet</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 6 }}>Alerts fire automatically when Heat ≥75 or unusual SWEEP detected</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {powerAlerts.map(alert => (
            <div
              key={alert.id}
              className="card"
              style={{
                padding: 14,
                borderLeft: `3px solid ${ALERT_TYPE_COLORS[alert.alert_type] || '#8b5cf6'}`,
                animation: Date.now() - new Date(alert.created_at).getTime() < 5000 ? 'flash 0.4s ease-out' : 'none',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                    <span style={{ background: `${ALERT_TYPE_COLORS[alert.alert_type]}20`, color: ALERT_TYPE_COLORS[alert.alert_type], fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.05em' }}>
                      {alert.alert_type}
                    </span>
                    <span className="ticker-pill">{alert.underlying}</span>
                    <HeatBadge score={alert.heat_score} />
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                      {formatTime(alert.created_at)}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: '#fafafa', fontFamily: "'JetBrains Mono', monospace" }}>
                    {alert.message}
                  </div>
                  {alert.ml_score > 0 && (
                    <div style={{ marginTop: 6, fontSize: 11, color: '#22c55e', fontFamily: "'JetBrains Mono', monospace" }}>
                      ML CONFIDENCE: {(alert.ml_score * 100).toFixed(0)}%
                    </div>
                  )}
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: heatColor(alert.heat_score), fontFamily: "'JetBrains Mono', monospace" }}>
                    {alert.heat_score}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.08em' }}>HEAT SCORE</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
