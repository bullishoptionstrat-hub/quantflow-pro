'use client'
import { useStore } from '@/store/useStore'
import { formatTime, heatColor } from '@/lib/utils'
import { HeatBadge } from '@/components/ui/HeatBadge'
import type { OrderType } from '@/lib/types'

/**
 * The page described a trigger the code does not implement, and credited a
 * model that does not exist.
 *
 * The subtitle read "AI-scored unusual activity · Heat ≥75 · SWEEP + Block
 * alerts". There is no model: `heat_score` comes from `flow-engine/score.ts`,
 * which is deterministic and publishes its own per-component breakdown, and
 * `ml-service/` was deleted for putting a number with no provenance beside a
 * real signal — this page's own `ML CONFIDENCE` line went with it. BLOCK is
 * not special-cased anywhere, and a SWEEP raises nothing on its own. The empty
 * state was wrong a third way: "Heat ≥75 **or** unusual SWEEP" describes a
 * disjunction, and the condition is a conjunction — `is_unusual && heat >= 75`,
 * on any order type.
 *
 * `ALERT_TYPE_COLORS` carried `DARK_POOL`, `GEX_FLIP` and `ML_SIGNAL`, which
 * nothing has ever produced; the alert's type is the signal's `order_type`.
 *
 * And an alert did not know whether the print behind it was real. On every
 * keyless deployment the backend simulates prints, and a simulated one clearing
 * the threshold was rendered here, spoken aloud and pushed to the desktop with
 * nothing saying so.
 */

const DEFAULT_ALERT_COLOR = '#8b5cf6'
/** Keyed by `OrderType` — the only thing `alert_type` has ever carried. */
const ALERT_TYPE_COLORS: Record<OrderType, string> = {
  SWEEP: '#8b5cf6', BLOCK: '#3b82f6',
  SPLIT: '#fbbf24', MULTI_LEG: '#34d399', LARGE: '#f472b6',
}
const alertColor = (t: OrderType) => ALERT_TYPE_COLORS[t] || DEFAULT_ALERT_COLOR

/** What actually raises an alert, in words, kept next to the predicate's home. */
const TRIGGER = 'Raised when the engine flags a signal unusual and scores it 75 or above — any order type.'

export default function PowerAlertsPage() {
  const { powerAlerts, voiceEnabled, setVoiceEnabled, connected } = useStore()
  const simulated = powerAlerts.filter(a => a.synthetic).length

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
          <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>{TRIGGER}</p>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
            Heat is <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>flow-engine/score.ts</span> — a deterministic score, not a model, and not a forecast.
          </p>
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

      {simulated > 0 && (
        <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 6, background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', fontSize: 11, color: '#fbbf24', fontFamily: "'JetBrains Mono', monospace" }}>
          🧪 {simulated} of these {powerAlerts.length} alerts came from simulated prints. They are spoken and pushed as simulated too.
        </div>
      )}

      {powerAlerts.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🔥</div>
          {/* Two different answers, the way the heat map and the flow feed
              distinguish them. "No alerts yet" said the same thing to a
              terminal with no feed at all and to a quiet tape. */}
          <div style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
            {connected ? 'No power alerts yet' : 'Not connected to the flow feed'}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 6 }}>
            {connected ? TRIGGER : 'No signals are arriving, so none can qualify. See Settings for source status.'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {powerAlerts.map(alert => (
            <div
              key={alert.id}
              className="card"
              style={{
                padding: 14,
                borderLeft: `3px solid ${alertColor(alert.alert_type)}`,
                animation: Date.now() - new Date(alert.created_at).getTime() < 5000 ? 'flash 0.4s ease-out' : 'none',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                    <span style={{ background: `${alertColor(alert.alert_type)}20`, color: alertColor(alert.alert_type), fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.05em' }}>
                      {alert.alert_type}
                    </span>
                    <span className="ticker-pill">{alert.underlying}</span>
                    <HeatBadge score={alert.heat_score} />
                    {alert.synthetic && (
                      <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'rgba(251,191,36,0.15)', color: '#fbbf24', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.05em' }}>
                        🧪 SIMULATED
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                      {formatTime(alert.created_at)}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: '#fafafa', fontFamily: "'JetBrains Mono', monospace" }}>
                    {alert.message}
                  </div>
                  {/*
                    A "ML CONFIDENCE: N%" line rendered here, gated on
                    `ml_score > 0`. Nothing ever populated it, and the service
                    that would have — `ml-service/` — was trained on data from
                    `np.random` with a fixed seed. Removed with the field, not
                    left waiting: a slot like this is one assignment away from
                    presenting a number with no provenance as a confidence.
                  */}
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: heatColor(alert.heat_score), fontFamily: "'JetBrains Mono', monospace" }}>
                    {alert.heat_score}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.08em' }}>HEAT SCORE</div>
                  {/* What produced it. The engine has published this all along
                      and the terminal never showed it — the same gap that made
                      `ml_score` dangerous: a large number in a strong colour
                      with nothing behind it a reader can check. */}
                  {alert.score_breakdown && Object.keys(alert.score_breakdown).length > 0 && (
                    <div style={{ marginTop: 6, fontSize: 9, color: 'var(--text-muted)', fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.5 }}>
                      {Object.entries(alert.score_breakdown).map(([k, v]) => (
                        <div key={k}>{k} {v > 0 ? '+' : ''}{v}</div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
