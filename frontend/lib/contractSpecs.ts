/**
 * Instruments the risk calculator can size, as price-increment arithmetic.
 *
 * These are external facts, and they have not been read from the exchange in
 * this repository: they are the standard published specifications as commonly
 * quoted. So the table says so (`SPEC_SOURCE.status`), the page shows it beside
 * every preset, and every preset can be overridden with CUSTOM. A wrong tick
 * value sizes a live order wrongly by the same factor, which is why the
 * calculator must never present one as checked when it is not.
 *
 * Three fields carry one fact on purpose. `tickValue` must equal
 * `tickSize × pointValue`; `contractSpecs.test.ts` holds every row to it, so a
 * typo in one field is caught by the other two instead of silently mis-sizing
 * an order. That is the check against the error the trade-ticket rules name:
 * multiplying a stop in POINTS by a value per TICK.
 *
 * Micro contracts are separate rows rather than a "divide by ten" flag: MES
 * and MNQ are different contracts with their own fills and fees, and the
 * calculator's answer when one contract of the full size exceeds the budget is
 * "pass, or size the micro", never "round up".
 */

export interface ContractSpec {
  symbol: string
  name: string
  venue: string
  /** What one unit of size is. Futures size in contracts, ETFs in shares. */
  unit: 'contract' | 'share'
  /** Minimum price increment. */
  tickSize: number
  /** Dollars per tick, per unit. */
  tickValue: number
  /** Dollars per 1.00 move in price, per unit. Equals tickValue / tickSize. */
  pointValue: number
  /** The smaller contract on the same underlying, when there is one. */
  micro?: string
}

export const SPEC_SOURCE = {
  status: 'UNVERIFIED' as const,
  basis:
    'Standard exchange contract specifications as commonly published (CME Group for ' +
    'equity-index and metals futures; one-cent increments for ETF shares). Not read ' +
    'from the exchange in this repository.',
  instruction: 'Confirm tick size and tick value with your broker before sizing a live order.',
}

export const CONTRACT_SPECS: readonly ContractSpec[] = [
  { symbol: 'ES',  name: 'E-mini S&P 500',       venue: 'CME',   unit: 'contract', tickSize: 0.25,  tickValue: 12.5, pointValue: 50,   micro: 'MES' },
  { symbol: 'MES', name: 'Micro E-mini S&P 500', venue: 'CME',   unit: 'contract', tickSize: 0.25,  tickValue: 1.25, pointValue: 5 },
  { symbol: 'NQ',  name: 'E-mini Nasdaq-100',    venue: 'CME',   unit: 'contract', tickSize: 0.25,  tickValue: 5,    pointValue: 20,   micro: 'MNQ' },
  { symbol: 'MNQ', name: 'Micro E-mini Nasdaq-100', venue: 'CME', unit: 'contract', tickSize: 0.25, tickValue: 0.5,  pointValue: 2 },
  { symbol: 'GC',  name: 'Gold (100 oz)',        venue: 'COMEX', unit: 'contract', tickSize: 0.1,   tickValue: 10,   pointValue: 100,  micro: 'MGC' },
  { symbol: 'MGC', name: 'Micro Gold (10 oz)',   venue: 'COMEX', unit: 'contract', tickSize: 0.1,   tickValue: 1,    pointValue: 10 },
  { symbol: 'SI',  name: 'Silver (5,000 oz)',    venue: 'COMEX', unit: 'contract', tickSize: 0.005, tickValue: 25,   pointValue: 5000, micro: 'SIL' },
  { symbol: 'SIL', name: 'Micro Silver (1,000 oz)', venue: 'COMEX', unit: 'contract', tickSize: 0.005, tickValue: 5, pointValue: 1000 },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF',     venue: 'NYSE Arca', unit: 'share', tickSize: 0.01,  tickValue: 0.01, pointValue: 1 },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust',    venue: 'Nasdaq',  unit: 'share',   tickSize: 0.01,  tickValue: 0.01, pointValue: 1 },
]

export function specFor(symbol: string): ContractSpec | undefined {
  return CONTRACT_SPECS.find((s) => s.symbol === symbol)
}
