import type { DecisionState } from '@/lib/tradeTicket'

/**
 * How each ticket verdict is printed. One map, read by the ticket and by the
 * desk, so a verdict cannot be worded or coloured two ways. Green and red are
 * the verdict's pass and fail; amber and orange are waiting and no size.
 */
export const TICKET_STATE_STYLE: Record<DecisionState, { label: string; color: string; bg: string; line: string }> = {
  NEUTRAL:          { label: 'NEUTRAL — WAITING',  color: '#a1a1aa', bg: 'rgba(161,161,170,0.12)', line: 'No direction chosen. Bias is earned, not assumed.' },
  WAIT_FOR_TRIGGER: { label: 'WAIT FOR TRIGGER',   color: '#fbbf24', bg: 'rgba(251,191,36,0.12)',  line: 'Not every required item is answered or measurable yet.' },
  BLOCKED:          { label: 'BLOCKED',            color: '#ef4444', bg: 'rgba(239,68,68,0.12)',   line: 'A required gate failed. No trade on this idea as it stands.' },
  NO_TRADE:         { label: 'NO TRADE · NO SIZE', color: '#f97316', bg: 'rgba(249,115,22,0.12)',  line: 'One unit risks more than the budget. It is not rounded up.' },
  APPROVED_TRADE:   { label: 'APPROVED TRADE',     color: '#22c55e', bg: 'rgba(34,197,94,0.12)',   line: 'Every required gate passed and the idea meets the minimum R. This places no order.' },
}
