/**
 * The display formatters.
 *
 * These lived as module-local functions inside `app/macro/page.tsx` and so
 * could not be tested at all. One of them was wrong in a way that mattered:
 * `cryptoPrice` rendered any sub-$1 asset with `toFixed(4)`, so SHIB at
 * 0.0000058 displayed as **$0.0000** — a live quote shown as zero, which is
 * the same defect as the dead sources it sat beside, arriving through the
 * formatter instead. It was caught by eye in a screenshot.
 */
import { describe, expect, test } from 'vitest'
import { fmt, pctColor, pcrColor, cryptoPrice, spotPrice, signedPct } from '@/lib/format'

describe('cryptoPrice', () => {
  test('never renders a live price as zero', () => {
    // The regression, stated as the property rather than the example: any
    // positive price must produce a string containing a non-zero digit.
    for (const v of [0.0000058, 1.234e-8, 0.001, 0.5, 2473.12, 78812]) {
      expect(cryptoPrice(v)).toMatch(/[1-9]/)
    }
  })

  test('sub-cent assets keep significant digits', () => {
    expect(cryptoPrice(0.0000058)).toBe('0.0000058')
    expect(cryptoPrice(0.00000001234)).toBe('0.00000001234')
  })

  test('ordinary prices are grouped and two-decimal', () => {
    expect(cryptoPrice(78812)).toBe('78,812.00')
    expect(cryptoPrice(2473.12)).toBe('2,473.12')
  })

  test('the cent-to-dollar band keeps four decimals', () => {
    expect(cryptoPrice(0.0832)).toBe('0.0832')
    expect(cryptoPrice(0.5)).toBe('0.5000')
  })

  test('zero and nonsense are not dressed up as prices', () => {
    expect(cryptoPrice(0)).toBe('0')
    expect(cryptoPrice(-1)).toBe('0')
    expect(cryptoPrice(NaN)).toBe('0')
  })

  test('trailing padding is trimmed, so the result reads as a number', () => {
    expect(cryptoPrice(0.001)).toBe('0.001')
    expect(cryptoPrice(0.0000058)).not.toMatch(/0$/)
  })
})

describe('pcrColor', () => {
  test('a missing ratio is grey, not bullish', () => {
    // The inline expression this replaced was `(v ?? 0) > 1 ? red : green`,
    // which coloured an unavailable put/call reading green.
    expect(pcrColor(null)).toBe('var(--text-muted)')
    expect(pcrColor(undefined)).toBe('var(--text-muted)')
  })

  test('above one is bearish, at or below is bullish', () => {
    expect(pcrColor(1.35)).toBe('#ef4444')
    expect(pcrColor(0.71)).toBe('#22c55e')
    expect(pcrColor(1)).toBe('#22c55e')
  })

  test('a real zero is a reading and is coloured as one', () => {
    // Distinct from null. The backend can report 0 and mean it.
    expect(pcrColor(0)).toBe('#22c55e')
    expect(pcrColor(0)).not.toBe(pcrColor(null))
  })
})

describe('pctColor', () => {
  test('sign decides the colour, flat is muted', () => {
    expect(pctColor(0.45)).toBe('#22c55e')
    expect(pctColor(-0.91)).toBe('#ef4444')
    expect(pctColor(0)).toBe('var(--text-muted)')
  })
})

describe('fmt', () => {
  test('compacts by magnitude', () => {
    expect(fmt(1.6e12)).toBe('$1.6T')
    expect(fmt(298.4e9)).toBe('$298.4B')
    expect(fmt(75.3e6)).toBe('$75.3M')
  })

  test('below a million it is a plain number, not a dollar string', () => {
    expect(fmt(651_600)).toBe('651600.00')
  })
})

describe('spotPrice', () => {
  test('an index price reads as a price, not a serial number', () => {
    expect(spotPrice(5587)).toBe('5,587.00')
    expect(spotPrice(1204.5)).toBe('1,204.50')
  })

  test('two decimals always, so the tape does not jitter in width', () => {
    expect(spotPrice(22)).toBe('22.00')
    expect(spotPrice(612.4)).toBe('612.40')
  })
})

describe('signedPct', () => {
  test('a gain carries its sign', () => {
    // Without this, +0.4% and 0.4% are the same string and the tape reads as
    // if nothing were up.
    expect(signedPct(0.4)).toBe('+0.40%')
    expect(signedPct(0)).toBe('+0.00%')
  })

  test('a loss keeps the one it already has, and is not double-signed', () => {
    expect(signedPct(-1.37)).toBe('-1.37%')
  })
})
