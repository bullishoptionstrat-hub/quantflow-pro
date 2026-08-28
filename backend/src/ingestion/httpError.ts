/**
 * Vendor failure → a diagnostic string that is safe to publish.
 *
 * `/api/health` is unauthenticated, so every string that reaches `sourceErrors`
 * is effectively public. This is the one place that decides what a connector
 * failure is allowed to say, which is why it lives on its own rather than being
 * re-hand-rolled per connector.
 *
 * Two rules:
 *
 *   1. **Carry the vendor's own words.** A bare `HTTP 403` does not distinguish
 *      "wrong key" from "your plan lacks this endpoint" from "no data for that
 *      symbol", and guessing between them in code is how the health route ends
 *      up confidently wrong. The body says which; the body is what is reported.
 *   2. **Never carry a credential.** Some vendors echo the request URL back in
 *      the error body, and several of this app's connectors put their key in the
 *      query string. Anything key-shaped is scrubbed on the way out.
 */

/** Query params whose values must never reach a public response. */
const SECRET_PARAMS = /((?:api[_-]?key|apikey|token|access[_-]?token|auth|secret)=)[^&\s"'<>]+/gi;

/** Bare `Bearer <something>` occurrences, e.g. an echoed Authorization header. */
const BEARER = /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

export const MAX_DETAIL_CHARS = 300;

export function redactSecrets(text: string): string {
  return text.replace(SECRET_PARAMS, '$1[REDACTED]').replace(BEARER, '$1[REDACTED]');
}

export function describeHttpError(err: any): string {
  const status = err?.response?.status;
  const body = err?.response?.data;

  const raw =
    typeof body === 'string' ? body
    : body != null ? safeStringify(body)
    : '';

  const detail = redactSecrets(raw.trim().replace(/\s+/g, ' '));
  const clipped = detail.length > MAX_DETAIL_CHARS
    ? `${detail.slice(0, MAX_DETAIL_CHARS)}…`
    : detail;

  if (!status) {
    // No response at all: DNS failure, timeout, connection reset. The message is
    // the only signal there is, and it can contain the URL, so it is scrubbed too.
    return redactSecrets(err?.message ?? 'unknown error');
  }
  return clipped ? `HTTP ${status} — ${clipped}` : `HTTP ${status}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // Circular or otherwise unserializable — a body we cannot read is not worth
    // failing a health report over.
    return '';
  }
}
