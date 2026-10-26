/**
 * Which commit each half of the system was built from, reported separately.
 *
 * The frontend's comes from `NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA`, which Vercel
 * inlines at build time; the backend's comes from `/api/health`'s `build`
 * block (Render's `RENDER_GIT_COMMIT`). Either can be unknown, and is shown
 * as unknown rather than filled in. Matching commits say both halves were
 * built from the same source; they say nothing about whether either is
 * working, and the page says so.
 */
export type BackendBuild =
  | { state: 'reported'; commit: string; shortCommit: string; source: string }
  | { state: 'unknown'; commit: null; shortCommit: null; reason: string }

const FULL_SHA = /^[0-9a-f]{40}$/

export function frontendCommit(raw: string | undefined = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA): string | null {
  const sha = raw?.trim().toLowerCase()
  return sha && FULL_SHA.test(sha) ? sha : null
}

/** Narrows whatever the backend sent; an older backend sends no `build` at all. */
export function backendBuild(body: unknown): BackendBuild | null {
  const b = (body as { build?: Partial<BackendBuild> } | null)?.build
  if (!b || typeof b !== 'object') return null
  if (b.state === 'reported' && typeof b.commit === 'string' && FULL_SHA.test(b.commit)) {
    return { state: 'reported', commit: b.commit, shortCommit: b.commit.slice(0, 7), source: String(b.source ?? '') }
  }
  if (b.state === 'unknown') {
    return { state: 'unknown', commit: null, shortCommit: null, reason: String((b as { reason?: unknown }).reason ?? '') }
  }
  return null
}

const mono = "'JetBrains Mono', monospace"
const REPO = 'https://github.com/bullishoptionstrat-hub/quantflow-pro/commit/'

function Row({ label, commit, detail }: { label: string; commit: string | null; detail: string }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', fontSize: 12 }}>
      <span style={{ width: 70, color: 'var(--text-muted)', fontFamily: mono, fontSize: 11 }}>{label}</span>
      {commit ? (
        <a href={REPO + commit} style={{ fontFamily: mono, color: '#c4b5fd' }}>{commit.slice(0, 7)}</a>
      ) : (
        <span style={{ fontFamily: mono, color: '#fbbf24' }}>UNKNOWN</span>
      )}
      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{detail}</span>
    </div>
  )
}

export function BuildIdentity({ health, frontend = frontendCommit() }: { health: unknown; frontend?: string | null }) {
  const backend = backendBuild(health)
  const backendDetail =
    health == null ? 'the backend did not answer'
    : backend == null ? 'the backend does not report its build (older than this page)'
    : backend.state === 'reported' ? `from ${backend.source}`
    : backend.reason
  return (
    <div className="card" style={{ marginBottom: 20 }} data-testid="build-identity">
      <div style={{ padding: 16, display: 'grid', gap: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, fontFamily: mono, color: 'var(--text-secondary)' }}>BUILD</div>
        <Row label="Frontend" commit={frontend} detail={frontend ? 'from Vercel (NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA)' : 'this build did not record a Vercel commit'} />
        <Row label="Backend" commit={backend?.state === 'reported' ? backend.commit : null} detail={backendDetail} />
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          The same commit on both sides means they were built from the same source, not that either is healthy.
        </div>
      </div>
    </div>
  )
}
