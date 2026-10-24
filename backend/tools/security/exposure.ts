/**
 * Credential exposure inventory — which credentials have ever been committed
 * to this repository, and where, WITHOUT ever printing a value.
 *
 * A key in a public git history is disclosed whether or not the tip still
 * carries it, so the question that matters for rotation is "what has ever
 * been here", not "what is here now". This walks every blob reachable from
 * every ref, opens zip archives (the original exposure was inside them), and
 * reports each finding as: variable name, kind, where it was first seen, and a
 * FINGERPRINT — the first 10 hex characters of the value's SHA-256. The
 * fingerprint lets an operator tell "the same key in five places" from "five
 * keys", and lets a later run show that a rotated key's replacement is not the
 * one that leaked, without the report itself becoming a second disclosure.
 *
 * Nothing here contacts a vendor. `verifyRevoked.ts` does that, and only when
 * an operator runs it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

/**
 * `high` — key-shaped: 16+ characters with letters and digits, or a vendor
 * prefix. `low` — a value under a SECRET or PASSWORD name that fails the
 * key-shape test: shorter than 16, or letters only. Session-signing secrets and
 * passwords are chosen by people and often look like that; a vendor-issued API
 * key almost never does, so the relaxed rule is confined to those two words.
 */
export type Confidence = 'high' | 'low';

export interface Exposure {
  /** Every variable name this one value was assigned to. One key can wear several. */
  names: string[];
  kind: string;
  fingerprint: string;
  /** Every `commit:path` the value was found at, oldest first. */
  seenAt: string[];
  /** Graded by the value alone, so every sighting of one value carries the same grade. */
  confidence: Confidence;
}

/**
 * `NAME=value`, `NAME: "value"`, `"NAME": "value"` — the three forms keys are written in.
 *
 * Whitespace around the separator is `[ \t]`, never `\s`: with `\s`, an empty
 * assignment (`SUPABASE_SERVICE_ROLE_KEY=`) consumed the newline and took the
 * NEXT line's text as its value, reporting an empty service-role key as an
 * exposed one. The length floor of 16 used to make that rare; the low-confidence
 * rule below would not.
 */
const ASSIGN =
  /(?:^|[\s{,(])["']?([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|DSN)[A-Z0-9_]*)["']?[ \t]*([=:])[ \t]*(["']?)([A-Za-z0-9_\-.]*)/g;

/** Names whose values people choose — where a short or letters-only value can still be the secret. */
const CHOSEN_SECRET = /SECRET|PASSWORD/;
/** Below this, a value is configuration (`true`, `1234`, `dev`) far more often than a secret. */
const MIN_LOW_CONFIDENCE = 6;
const MIN_KEY_SHAPED = 16;
/** A value that only names its own role — `SECRET: 'secret'` — is a fixture, not a chosen secret. */
const ROLE_WORD = /^(?:secret|password|passwd|pass|pwd)$/i;
/** `os.environ.get`, `settings.webhook_secret` — a dotted path is code reading a value, not the value. */
const DOTTED_CODE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

const PLACEHOLDER =
  /^(?:your|my|the|a)[-_]|(?:[-_]your[-_]|xxx|placeholder|example|changeme|change[-_]me|replace[-_]me|dummy|sample|todo|fixme|test|fake|stub|mock|redacted)/i;

/**
 * A fixture built as a run of consecutive characters — `0123456789abcdef…` —
 * after any vendor prefix. Test files fabricate keys this way precisely so
 * they cannot be real, and reporting one as an exposure would send an
 * operator to rotate a key that never existed.
 */
export function isSyntheticSequence(value: string): boolean {
  const body = value.replace(/^(?:fc-|sk-|sb_)/, '').toLowerCase();
  if (body.length < 12) return false;
  const order = '0123456789abcdefghijklmnopqrstuvwxyz';
  let steps = 0;
  for (let i = 1; i < body.length; i++) {
    const a = order.indexOf(body[i - 1]!), b = order.indexOf(body[i]!);
    if (a >= 0 && b >= 0 && (b === a + 1 || (a === 15 && b === 0) || (a === 35 && b === 0))) steps++;
  }
  return steps / (body.length - 1) >= 0.9;
}

export const fingerprint = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 10);

/**
 * Every (name, value) a text body assigns, placeholders and code identifiers
 * excluded, each graded `high` or `low` (see `Confidence`). An empty value
 * clears neither length floor, so it is never reported.
 */
export function findAssignments(text: string): Array<{ name: string; value: string; confidence: Confidence }> {
  const out: Array<{ name: string; value: string; confidence: Confidence }> = [];
  for (const m of text.matchAll(ASSIGN)) {
    const name = m[1]!;
    const separator = m[2]!;
    const quoted = m[3] !== '';
    const value = m[4]!;
    if (DOTTED_CODE.test(value) && !/[0-9]/.test(value)) continue;
    if (PLACEHOLDER.test(value)) continue;
    // `process.env.X`, `env.X`, an identifier — code, not a value.
    if (/^(process|env|req|config|options|opts|this)\b/.test(value)) continue;
    if (/^[A-Z][A-Z0-9_]+$/.test(value)) continue;   // another constant's name
    if (isSyntheticSequence(value)) continue;
    // A real key has both letters and digits, or a vendor prefix; prose and
    // identifiers rarely have either.
    const prefixed = /^(?:fc-|sk-|eyJ|sb_|ghp_|xox)/.test(value);
    const keyShaped = value.length >= MIN_KEY_SHAPED
      && (prefixed || (/[0-9]/.test(value) && /[A-Za-z]/.test(value)));
    if (keyShaped) { out.push({ name, value, confidence: 'high' }); continue; }
    // A secret someone chose. Short or letters-only is not evidence it is
    // fake, so it is reported — separately, because it is also what ordinary
    // config looks like, and an operator should not rotate on it unread.
    //
    // Unquoted after `:` is an object-literal or keyword-argument reference to
    // a variable (`PGRST_JWT_SECRET: secret,`), so the low grade needs a quote
    // or a dotenv/shell `=`. That costs an unquoted short secret in YAML.
    if (CHOSEN_SECRET.test(name) && value.length >= MIN_LOW_CONFIDENCE && /[A-Za-z]/.test(value)
        && !ROLE_WORD.test(value) && (quoted || separator === '=')) {
      out.push({ name, value, confidence: 'low' });
    }
  }
  return out;
}

/** The text files inside a zip, decoded. Stored and deflated entries only. */
export function zipEntries(buf: Buffer): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const csize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const path = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + csize);
    try {
      const raw = method === 0 ? data : method === 8 ? inflateRawSync(data) : null;
      if (raw && !raw.includes(0)) out.push({ path, text: raw.toString('utf8') });
    } catch { /* an entry that will not inflate is not readable text */ }
    if (csize === 0 && method !== 0) break;  // streamed entry; sizes live in a trailer
    i = start + csize;
  }
  return out;
}

function git(args: string[], cwd: string): Buffer {
  return execFileSync('git', args, { cwd, maxBuffer: 512 * 1024 * 1024 });
}

/**
 * Files in the working tree — tracked or not, ignored or not — that still hold
 * a value from `fps`. This is the "remaining references" check, and it reads
 * `.env` files deliberately: a rotated key that was never replaced locally is
 * still the compromised one. Only paths are returned.
 */
export function referencesIn(paths: readonly string[], read: (p: string) => string | null, fps: ReadonlySet<string>): string[] {
  const hits: string[] = [];
  for (const p of paths) {
    const text = read(p);
    if (text === null) continue;
    if (findAssignments(text).some(({ value }) => fps.has(fingerprint(value)))) hits.push(p);
  }
  return hits;
}

/** Every credential assignment in history, as (name, value, where). Values stay in memory. */
export function* walkHistory(repo: string): Generator<{ name: string; value: string; at: string; confidence: Confidence }> {
  const seenBlob = new Set<string>();
  const commits = git(['rev-list', '--all', '--reverse'], repo).toString().trim().split('\n').filter(Boolean);
  for (const c of commits) {
    const tree = git(['ls-tree', '-r', '-z', c], repo).toString().split('\0').filter(Boolean);
    for (const line of tree) {
      const [meta, path] = line.split('\t');
      const [, type, blob] = meta!.split(' ');
      if (type !== 'blob' || seenBlob.has(blob!)) continue;
      seenBlob.add(blob!);
      const body = git(['cat-file', 'blob', blob!], repo);
      const texts = /\.zip$/i.test(path!)
        ? zipEntries(body).map((e) => ({ where: `${path}!${e.path}`, text: e.text }))
        : body.includes(0) || body.length > 4_000_000 ? [] : [{ where: path!, text: body.toString('utf8') }];
      for (const { where, text } of texts) {
        for (const { name, value, confidence } of findAssignments(text)) {
          yield { name, value, confidence, at: `${c.slice(0, 8)}:${where}` };
        }
      }
    }
  }
}

/** Walk every blob in history once, and record where each credential appears. */
export function scanHistory(repo: string, values?: Map<string, string>): Exposure[] {
  const byFp = new Map<string, Exposure>();
  for (const { name, value, at, confidence } of walkHistory(repo)) {
    const fp = fingerprint(value);
    values?.set(fp, value);
    const e = byFp.get(fp) ?? { names: [], kind: 'assigned credential', fingerprint: fp, seenAt: [], confidence };
    if (!e.names.includes(name)) e.names.push(name);
    if (!e.seenAt.includes(at)) e.seenAt.push(at);
    byFp.set(fp, e);
  }
  return [...byFp.values()].sort((a, b) => a.names[0]!.localeCompare(b.names[0]!));
}

/** The report, as lines. Names, fingerprints and locations only — it is given no values to print. */
export function formatReport(report: readonly Exposure[]): string[] {
  const line = (e: Exposure) =>
    `${e.names.join(' = ').padEnd(48)} fp=${e.fingerprint}  places=${e.seenAt.length}  first=${e.seenAt[0]}`;
  const high = report.filter((e) => e.confidence === 'high');
  const low = report.filter((e) => e.confidence === 'low');
  const out = high.map(line);
  if (low.length) {
    out.push('', 'Low confidence — a short or letters-only value under a SECRET/PASSWORD name.',
      'Could be a real chosen secret or ordinary config: check before acting on it.', ...low.map(line));
  }
  out.push('', `${high.length} key-shaped and ${low.length} low-confidence credential value(s) found in history. Values are never printed.`);
  return out;
}

if (require.main === module) {
  for (const l of formatReport(scanHistory(process.argv[2] ?? process.cwd()))) console.log(l);
}
