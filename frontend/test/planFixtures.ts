/**
 * A daily plan built through the app's own functions, for tests that need one.
 * Not a test file: Vitest only collects `*.test.*`.
 */
import { createPlan, emptyBody, type DailyPlan, type PlanBody } from '@/lib/dailyPlan'

/** Every checklist item filled: two levels, three scenarios, one event, limits. */
export function completeBody(o: Partial<PlanBody> = {}): PlanBody {
  return {
    ...emptyBody(),
    instruments: ['ES', 'NQ'],
    htfBias: 'BULLISH',
    sessionProfile: 'ONEPAGER',
    levels: [
      { label: 'Prior day high', price: 5030, type: 'PDH', liquidity: 'EXTERNAL', status: 'FRESH' },
      { label: 'London low', price: 4988, type: 'LONDON_L', liquidity: 'EXTERNAL', status: 'MITIGATED' },
    ],
    range: { high: 5030, low: 4970 },
    scenarios: {
      primary: { if: 'London low is swept and reclaimed', then: 'Long from the 1H iFVG', invalidation: 'Close below 4985', opposingLiquidity: 'PDH 5030', targets: '5030' },
      alternate: { if: 'PDH is swept and rejected', then: 'Short back to EQ', invalidation: 'Close above 5040', opposingLiquidity: 'London low', targets: '5000' },
      noTrade: { if: 'Chop inside 4995–5010', then: 'Stand aside', invalidation: 'A displacement out of the box', opposingLiquidity: '', targets: '' },
    },
    events: [{ time: '08:30', name: 'CPI', beforeMin: 5, afterMin: 15 }],
    eventsChecked: 'BLS release calendar',
    lossLimit: 500,
    maxAttempts: 2,
    ...o,
  }
}

export function completePlan(date: string, o: Partial<PlanBody> = {}, now = `${date}T11:00:00.000Z`): DailyPlan {
  const made = createPlan([], date, completeBody(o), now, [])
  if ('error' in made) throw new Error(made.error)
  return made.plan
}
