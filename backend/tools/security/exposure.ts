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
 * How sure the inventory is that a value is a live credential.
 *
 * `high` — key-shaped: 16+ characters with letters and digits, or a vendor
 * prefix. `low` — 6+ characters with a letter that fail the key-shape test:
 * shorter than 16, or letters only. Session-signing secrets, passwords and
 * hand-set tokens look like that, and so does ordinary config, so these are
 * listed separately and read before anyone rotates on them.
 *
 * Nothing under a credential name is dropped for its length alone. What is not
 * listed is still COUNTED, by name, in the report's summary (`Skipped`):
 * `trivial` (1–5 characters — `x`, `abc`, the bulk of test fixtures), `template`
 * (`change-me`, `your-…`, a role word like `secret`), `numeric` (digits with no
 * letter — a PIN or a setting; read it before acting) and `empty` (nothing, or
 * something other than a literal — `NAME: [`, `${OTHER}`). Code that reads a
 * value — `process.env.X`, `os.environ.get`, a constant's name, an unquoted
 * identifier — is not a value at all and is not counted, and neither is a
 * number under a name that says it is a setting (`MAX_TOKENS`, `TOKEN_TTL`).
 */
export type Confidence = 'high' | 'low';
export type SkipKind = 'trivial' | 'numeric' | 'template' | 'empty';
export type Category = Confidence | SkipKind;

/** Per kind, per variable name: how many assignments were recognised and not listed. */
export type Skipped = Record<SkipKind, Map<string, number>>;
export const newSkipped = (): Skipped => ({ trivial: new Map(), numeric: new Map(), template: new Map(), empty: new Map() });

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
 * The fingerprint as it may be shown. A 10-hex SHA-256 prefix of a key-shaped
 * value cannot be reversed; one of a short or letters-only value can be
 * brute-forced, so printing it would disclose the value. Low findings are
 * still grouped by fingerprint internally — it is only never displayed.
 */
export const displayFingerprint = (e: Pick<Exposure, 'fingerprint' | 'confidence'>) =>
  (e.confidence === 'high' ? e.fingerprint : 'withheld');

/**
 * `NAME=value`, `NAME: "value"`, `"NAME": "value"` — the three forms keys are
 * written in. This finds the name and the separator; `readValue` reads the
 * value from there.
 *
 * Whitespace around the separator is `[ \t]`, never `\s`: with `\s`, an empty
 * assignment (`SUPABASE_SERVICE_ROLE_KEY=`) consumed the newline and took the
 * NEXT line's text as its value, reporting an empty service-role key as an
 * exposed one. The length floor of 16 used to make that rare; the low-confidence
 * rule below would not.
 */
const ASSIGN =
  /(?:^|[\s{,(])["']?([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|DSN)[A-Z0-9_]*)["']?[ \t]*([=:])[ \t]*/g;

/**
 * An unquoted value is a run of the characters secrets and connection strings
 * are written in: letters, digits, `_ - .`, the base64 and URL characters
 * `+ / = @ : ~ ! % * # $ & ? ^`. It ends at anything else — whitespace (which
 * is also what starts a trailing ` # …` comment in shell and YAML), a quote,
 * `,` `;` `|`, a bracket — so a line of code is not read as one long value.
 *
 * It used to be `[A-Za-z0-9_\-.]` — a key-shaped alphabet — so a value was cut
 * at its first `+`, `/` or `@`. An `openssl rand -base64` secret came out as two
 * characters and was counted as a trivial fixture instead of being listed.
 */
const UNQUOTED_RUN = /[A-Za-z0-9_\-.+/=@:~!%*#$&?^]*/y;

/**
 * The value starting at `i`, read whole. A quoted value runs to its closing
 * quote on the same line (`\"` escapes in double quotes, as in JSON and shell);
 * an unterminated quote falls back to the unquoted reading of what follows it,
 * so a broken line is neither swallowed nor allowed to run into the next one.
 */
export function readValue(text: string, i: number): { value: string; quoted: boolean; end: number } {
  const unquoted = (from: number) => {
    UNQUOTED_RUN.lastIndex = from;
    const run = UNQUOTED_RUN.exec(text)![0];
    return { run, end: from + run.length };
  };
  const q = text[i];
  if (q === '"' || q === "'") {
    let value = '';
    for (let j = i + 1; j < text.length && text[j] !== '\n' && text[j] !== '\r'; j++) {
      const c = text[j]!;
      if (c === '\\' && q === '"' && j + 1 < text.length && text[j + 1] !== '\n') { value += text[++j]; continue; }
      if (c === q) return { value, quoted: true, end: j + 1 };
      value += c;
    }
    const { run, end } = unquoted(i + 1);
    return { value: run, quoted: true, end };
  }
  const { run, end } = unquoted(i);
  return { value: run, quoted: false, end };
}

/** Below this, a value is a fixture or config (`x`, `abc`, `dev`) far more often than a secret: counted, not listed. */
const MIN_LOW_CONFIDENCE = 6;
const MIN_KEY_SHAPED = 16;
/** A value that only names its own role — `SECRET: 'secret'` — is a fixture, not a chosen secret. */
const ROLE_WORD = /^(?:secret|password|passwd|pass|pwd)$/i;
/** `os.environ.get`, `settings.webhook_secret` — a dotted path is code reading a value, not the value. */
const DOTTED_CODE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
/** What precedes a name declared in JS/TS source: `const `, `export let `, `var `. */
const CODE_DECLARATION = /\b(?:const|let|var)\s+$/;
/** `$OTHER`, `${OTHER}` — an interpolation, not a literal. `$2b$10$…` (a bcrypt hash) is a literal. */
const INTERPOLATION = /^\$(?:\{|[A-Za-z_])/;
/**
 * A name that says its number is a setting, not a secret: `MAX_TOKENS`,
 * `TOKEN_TTL_SECONDS`, `PASSWORD_MIN_LENGTH`. A number under any other
 * credential name is counted as `numeric`, never dropped.
 */
const NUMERIC_SETTING =
  /(?:^|_)(?:TTL|TIMEOUT|EXPIRY|EXPIRES|EXPIRATION|AGE|LENGTH|LEN|SIZE|MAX|MIN|COUNT|LIMIT|PORT|TOKENS|RETRIES|RETRY|INTERVAL|BITS|ROUNDS|ID|INDEX|VERSION|SECONDS|MS|MINUTES|HOURS|DAYS|DURATION|LIFETIME|BUDGET|THRESHOLD)(?:_|$)/;

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
 * Every assignment under a credential name, sorted into a `Category` (see
 * `Confidence`). Code that reads a value rather than holding one is omitted.
 */
export function classifyAssignments(text: string): Array<{ name: string; value: string; category: Category }> {
  const out: Array<{ name: string; value: string; category: Category }> = [];
  const re = new RegExp(ASSIGN.source, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const name = m[1]!;
    const separator = m[2]!;
    const { value, quoted, end } = readValue(text, m.index + m[0].length);
    // Resume after the value, so a value's own text is never read as another assignment.
    re.lastIndex = Math.max(end, re.lastIndex);
    // `const NAME = /…/`, `let NAME = x + y`: in source code a literal is always
    // quoted, so an unquoted right-hand side of a declaration is an expression.
    const nameAt = m.index + m[0].indexOf(name);
    if (!quoted && CODE_DECLARATION.test(text.slice(text.lastIndexOf('\n', nameAt) + 1, nameAt))) continue;
    if (value.length === 0 || INTERPOLATION.test(value)) { out.push({ name, value, category: 'empty' }); continue; }
    // Code reading a value, not a value: `os.environ.get`, `process.env.X`,
    // another constant's name, an unquoted `NAME: identifier` reference.
    // A dotted path is code (`os.environ.get`, compiled `zod_1.z.string`,
    // `REQUIRED.SUPABASE_SERVICE_KEY`) — unless it is a JWT, whose segments look
    // the same and which always opens `eyJ` (base64url of `{"`).
    if (DOTTED_CODE.test(value) && !value.startsWith('eyJ')) continue;
    if (/^(process|env|req|config|options|opts|this)\b/.test(value)) continue;
    if (/^[A-Z][A-Z0-9_]+$/.test(value)) continue;
    if (!quoted && separator === ':' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && value.length < MIN_KEY_SHAPED) continue;
    if (PLACEHOLDER.test(value) || ROLE_WORD.test(value) || isSyntheticSequence(value)) {
      out.push({ name, value, category: 'template' }); continue;
    }
    // A real key has both letters and digits, or a vendor prefix; prose and
    // identifiers rarely have either.
    const prefixed = /^(?:fc-|sk-|eyJ|sb_|ghp_|xox)/.test(value);
    const keyShaped = value.length >= MIN_KEY_SHAPED
      && (prefixed || (/[0-9]/.test(value) && /[A-Za-z]/.test(value)));
    if (keyShaped) { out.push({ name, value, category: 'high' }); continue; }
    if (!/[A-Za-z]/.test(value)) {
      // No letter at all. Digits are a PIN or a setting: counted unless the name
      // says setting. No digit either (`...`, `***`) is not a readable literal.
      if (!/[0-9]/.test(value)) out.push({ name, value, category: 'empty' });
      else if (!NUMERIC_SETTING.test(name)) out.push({ name, value, category: 'numeric' });
      continue;
    }
    out.push({ name, value, category: value.length >= MIN_LOW_CONFIDENCE ? 'low' : 'trivial' });
  }
  return out;
}

/** The assignments worth listing: `high` and `low`. Everything else is counted by `walkHistory`. */
export function findAssignments(text: string): Array<{ name: string; value: string; confidence: Confidence }> {
  const out: Array<{ name: string; value: string; confidence: Confidence }> = [];
  for (const a of classifyAssignments(text)) {
    if (a.category === 'high' || a.category === 'low') out.push({ name: a.name, value: a.value, confidence: a.category });
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
export function* walkHistory(repo: string, skipped?: Skipped): Generator<{ name: string; value: string; at: string; confidence: Confidence }> {
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
        for (const { name, value, category } of classifyAssignments(text)) {
          if (category === 'high' || category === 'low') {
            yield { name, value, confidence: category, at: `${c.slice(0, 8)}:${where}` };
          } else if (skipped) {
            skipped[category].set(name, (skipped[category].get(name) ?? 0) + 1);
          }
        }
      }
    }
  }
}

/** Walk every blob in history once, and record where each credential appears. */
export function scanHistory(repo: string, values?: Map<string, string>, skipped?: Skipped): Exposure[] {
  const byFp = new Map<string, Exposure>();
  for (const { name, value, at, confidence } of walkHistory(repo, skipped)) {
    const fp = fingerprint(value);
    values?.set(fp, value);
    const e = byFp.get(fp) ?? { names: [], kind: 'assigned credential', fingerprint: fp, seenAt: [], confidence };
    if (!e.names.includes(name)) e.names.push(name);
    if (!e.seenAt.includes(at)) e.seenAt.push(at);
    byFp.set(fp, e);
  }
  return [...byFp.values()].sort((a, b) => a.names[0]!.localeCompare(b.names[0]!));
}

/**
 * The report, as lines. Names, locations and — for key-shaped values only —
 * fingerprints. It is given no values to print.
 */
export function formatReport(report: readonly Exposure[], skipped?: Skipped): string[] {
  const line = (e: Exposure) =>
    `${e.names.join(' = ').padEnd(48)} fp=${displayFingerprint(e)}  places=${e.seenAt.length}  first=${e.seenAt[0]}`;
  const high = report.filter((e) => e.confidence === 'high');
  const low = report.filter((e) => e.confidence === 'low');
  const out = high.map(line);
  if (low.length) {
    out.push('', 'Low confidence — a 6–15 character or letters-only value under a credential name.',
      'Could be a real chosen secret or ordinary config: check before acting on it. Fingerprints are',
      'withheld here because a hash prefix of a short value can be brute-forced.', ...low.map(line));
  }
  if (skipped) {
    const kinds: Array<[SkipKind, string]> = [
      ['trivial', '1–5 characters'], ['numeric', 'digits only (a PIN or a setting — read before acting)'],
      ['template', 'template default or placeholder'], ['empty', 'empty or not a literal (an array, a call, ${…})'],
    ];
    const rows = kinds.filter(([k]) => skipped[k].size > 0).map(([k, label]) => {
      const names = [...skipped[k]].sort(([a], [b]) => a.localeCompare(b)).map(([n, c]) => `${n}×${c}`).join(', ');
      const total = [...skipped[k].values()].reduce((a, b) => a + b, 0);
      return `  ${label} (${total}): ${names}`;
    });
    if (rows.length) out.push('', 'Recognised and not listed (counted by name; values are never printed):', ...rows);
  }
  out.push('', `${high.length} key-shaped and ${low.length} low-confidence credential value(s) found in history. Values are never printed.`);
  return out;
}

if (require.main === module) {
  const skipped = newSkipped();
  for (const l of formatReport(scanHistory(process.argv[2] ?? process.cwd(), undefined, skipped), skipped)) console.log(l);
}
