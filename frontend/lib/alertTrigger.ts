import type { AlertTrigger } from '@/lib/types'

/**
 * The rule that raised one alert, and where it went, in words (ROADMAP 5.3).
 * Reads only what the row recorded when it fired — nothing here is recomputed
 * against today's thresholds.
 */
export function describeTrigger(t: AlertTrigger): string {
  const rule = t.unusual_threshold === null
    ? `heat ${t.heat_score} · flagged unusual by the backend (threshold not published)`
    : `heat ${t.heat_score} ≥ ${t.unusual_threshold} unusual threshold`
  const out: string[] = []
  if (t.spoken) out.push(`spoken (heat > ${t.speak_above})`)
  if (t.pushed) out.push(`pushed (heat > ${t.push_above})`)
  return `RAISED BY ${rule} · ${out.length ? out.join(' · ') : 'in-app only'}`
}
