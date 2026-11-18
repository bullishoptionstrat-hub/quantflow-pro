/**
 * The flow feed's CSV export. It used to be built inline in `FlowFeed.tsx`
 * with a bare `join(',')`, so it was the one exporter that skipped the cell
 * rules `replayCsv.ts` and `journalCsv.ts` share: a vendor string starting
 * with `=` became a formula, and a comma or newline in one moved every later
 * column. Every cell now goes through `textCell` / `numCell`, and the filter
 * line has newlines removed so a typed ticker cannot start a data row.
 */
import type { FlowEvent, FlowFilters } from './types'
import { numCell, textCell } from './replayCsv'

export const FLOW_CSV_HEADER =
  'Time,Ticker,Expiry,Strike,Type,Order,Size,Premium,Heat,Sentiment,Synthetic,Datasets,RightsDisplay'

function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ')
}

export function flowCsv(
  rows: readonly FlowEvent[],
  heldCount: number,
  filters: FlowFilters,
  formatTime: (iso: string) => string,
): string {
  const meta = [
    `# quantflow flow export — ${rows.length} of ${heldCount} signals held this session`,
    oneLine(`# filters: ticker=${filters.ticker || 'any'} premium>=${filters.minPremium} type=${filters.optionType} order=${filters.orderType} sentiment=${filters.sentiment} heat>=${filters.minHeat}${filters.unusualOnly ? ' unusualOnly' : ''}`),
  ]
  const body = rows.map((e) =>
    [
      textCell(formatTime(e.created_at)), textCell(e.underlying), textCell(e.expiry), numCell(e.strike),
      textCell(e.option_type), textCell(e.order_type), numCell(e.total_size), numCell(e.total_premium),
      numCell(e.heat_score), textCell(e.sentiment), e.synthetic ? 'yes' : 'no',
      textCell((e.datasets ?? []).join(';') || 'UNKNOWN'), textCell(e.rights_display ?? 'UNKNOWN_DATASET'),
    ].join(','),
  )
  return [...meta, FLOW_CSV_HEADER, ...body].join('\n') + '\n'
}
