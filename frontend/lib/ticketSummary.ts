/**
 * A ticket record as plain text for a pre-entry screenshot or a paste.
 *
 * It reads the frozen record (`ticketRecord`) and nothing else, so the text
 * can never say something the saved record does not. Rules:
 * - The first line says it places no order, and the state is the record's.
 * - An absent figure prints `—`, never 0.
 * - Every gate prints with its source (TRADER / COMPUTED / …), so a reader
 *   can tell an observation from a measurement.
 * - The score prints as ranking only, because it approves nothing.
 */
import type { TicketRecord } from './tradeTicket'

function n(v: number | null | undefined, digits = 2): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  const s = v.toFixed(digits)
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

export function ticketSummary(r: TicketRecord): string {
  const p = r.plan
  const lines = [
    `QUANTFLOW TICKET · ${r.state} · NOT AN ORDER`,
    `created ${r.createdAt} · schema ${r.schema} · contract spec ${r.specStatus}`,
    `${r.symbol}${r.contract ? ` (${r.contract})` : ''} · ${r.direction} · setup ${r.setupId || '—'} · model ${r.model}`,
    r.origin ? `origin: replay idea ${r.origin.ideaId} (${r.origin.setup}, ${r.origin.setupMethodVersion})` : 'origin: typed by hand',
    `entry ${n(p.entry)} · stop ${n(p.stop)} · units ${n(p.units, 0)} · planned risk ${n(p.plannedRisk)} · blended net R ${n(p.blendedNetR)} (min ${n(p.minR)})`,
    `budget ${n(p.riskBudget)} · cost/unit ${n(p.costPerUnit)} · slippage ticks ${n(p.slippageTicks)}`,
    ...p.targets.map((t, i) => `target ${i + 1}: ${n(t.price)} ${t.kind ?? ''} · units ${n(t.units, 0)} · net R ${n(t.netR)}`.trimEnd()),
    'gates:',
    ...r.gates.map((g) => `  ${g.status.padEnd(12)} ${g.id}${g.required ? '' : ' (optional)'} · ${g.source}`),
    `blockers: ${r.blockers.length ? r.blockers.map((b) => b.code).join(', ') : 'none'}`,
    `score ${r.score.value}/${r.score.of} · ranking only, approves nothing`,
    r.note,
  ]
  return lines.join('\n')
}
