/**
 * The `/api/*` rewrite proxy must list every backend route the browser calls.
 *
 * `next.config.js` claims in a comment to enumerate "every router mounted in
 * backend/src/server.ts", and nothing held it to that — so `track-record` was
 * mounted on the backend, called by a page, and *missing from the proxy list*,
 * which means the request would have 404'd at the Next server instead of
 * reaching Render. `backtest` was about to ship with the same gap.
 *
 * This reads both sides and asserts the proxy is a superset of what the backend
 * exposes on the demo/auth tiers. The health route is included; `/health`
 * (no `/api`) is the backend's own liveness path and is not proxied, so it is
 * not asserted here.
 */
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')

/** The segments the proxy forwards, read out of next.config.js. */
function proxySegments(): string[] {
  const src = readFileSync(join(ROOT, 'frontend', 'next.config.js'), 'utf8')
  const m = src.match(/const API_SEGMENTS = \[([^\]]*)\]/)
  if (!m) throw new Error('could not find API_SEGMENTS in next.config.js')
  return m[1]!.split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
}

/** Every `/api/<seg>` the backend mounts, read out of server.ts. */
function backendSegments(): string[] {
  const src = readFileSync(join(ROOT, 'backend', 'src', 'server.ts'), 'utf8')
  const segs: string[] = []
  const re = /app\.use\(\s*'\/api\/([a-z0-9-]+)'/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (!segs.includes(m[1]!)) segs.push(m[1]!)
  }
  return segs
}

test('every backend /api route the browser can reach is in the proxy allowlist', () => {
  const proxy = proxySegments()
  const missing = backendSegments().filter((seg) => !proxy.includes(seg))
  expect(missing, `these backend routes are mounted but not proxied by next.config.js: ${missing.join(', ')}`).toEqual([])
})

test('the backtest route in particular is proxied', () => {
  // The route this suite of features adds. A regression here means the page
  // renders but every "Run backtest" 404s at the Next server.
  expect(proxySegments()).toContain('backtest')
})
