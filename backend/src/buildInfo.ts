/**
 * Which commit this process is running, as the deployment platform reported it.
 *
 * `/api/health` used to say `version: '1.0.0'`, a literal no deploy ever
 * changed, so nothing could say whether a merged fix was actually running.
 * Render sets `RENDER_GIT_COMMIT` to the full SHA it built from; that is the
 * only source used, and anything else is reported as unknown with the reason.
 * A missing or malformed value is never replaced by a guess: a fabricated
 * commit is worse than none, because it answers the one question this field
 * exists for with a confident wrong answer.
 *
 * The SHA is not sensitive: the repository is public, and the value names a
 * commit anyone can already read.
 */
export type BuildInfo =
  | { state: 'reported'; commit: string; shortCommit: string; source: 'RENDER_GIT_COMMIT' }
  | { state: 'unknown'; commit: null; shortCommit: null; reason: string }

const FULL_SHA = /^[0-9a-f]{40}$/

export function buildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const raw = env.RENDER_GIT_COMMIT
  if (raw === undefined || raw.trim() === '') {
    return {
      state: 'unknown', commit: null, shortCommit: null,
      reason: 'RENDER_GIT_COMMIT is not set: this process was not built by Render, or Render did not report a commit.',
    }
  }
  const sha = raw.trim().toLowerCase()
  if (!FULL_SHA.test(sha)) {
    // The value is not echoed: it is not a commit, so it identifies nothing,
    // and a string in an unexpected shape has no business on a public route.
    return {
      state: 'unknown', commit: null, shortCommit: null,
      reason: 'RENDER_GIT_COMMIT is set but is not a 40-character hex commit SHA.',
    }
  }
  return { state: 'reported', commit: sha, shortCommit: sha.slice(0, 7), source: 'RENDER_GIT_COMMIT' }
}
