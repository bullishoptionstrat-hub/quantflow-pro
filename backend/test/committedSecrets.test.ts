/**
 * Nothing tracked in this repository may carry a credential, and no archive
 * is tracked at all — because an archive is where the ones it did carry were
 * hiding, unreadable to every review that reads a diff.
 *
 * ── What this was written for ───────────────────────────────────────────────
 *
 * `docs/FORENSIC_AUDIT.md` #7, raised in the draft PR of 2026-08-28, said real
 * credentials were committed inside the root zip files and had to be rotated.
 * Roughly fifty pull requests landed after that and the finding was still
 * live: several archives were tracked, in a **public** repository, and
 * `.gitignore` did not merely fail to exclude them — it named three of them in
 * `!` exceptions that forced them in. Two of those three contained an `.env`
 * with vendor API keys in it, one of them a metered service that bills per
 * call. The Supabase service-role key — the one that bypasses RLS — was not
 * among them, which is the only reason this is a key-rotation problem and not
 * an open database.
 *
 * The specific inventory is deliberately not written out here. This file is
 * public, the disclosure it describes is not yet closed at the vendors, and a
 * precise index of which credential sits in which historical blob is a
 * convenience for exactly one kind of reader. It is recorded where the people
 * who have to rotate them can see it.
 *
 * ── Why an archive specifically ─────────────────────────────────────────────
 *
 * Every other guard in this suite reads source. A reviewer reads a diff. A zip
 * is opaque to both: `git show` prints `Binary files differ`, the GitHub web
 * view offers a download, and secret scanners that walk text files walk past
 * it. The exception list in `.gitignore` is what made it possible, and it was
 * added deliberately by someone who wanted the archives available — which is
 * the ordinary way this happens. So the rule is enforced here against what is
 * *actually tracked*, not against a pattern that a future `!` line can undo.
 *
 * ── What this does not do ───────────────────────────────────────────────────
 *
 * **It does not make the exposed keys safe.** Removing a file from the tip
 * does not remove it from history, and these were pushed to a public remote.
 * Anything that was in them must be treated as disclosed and rotated at the
 * vendor, which is an action outside this repo and cannot be tested from
 * inside it. This guard stops the next one; it does nothing about the last.
 *
 * It also reads only what it knows the shape of. A credential in a format not
 * matched below, or in an archive format not opened below (`.7z`, `.rar`, a
 * password-protected zip), passes — so the archive ban in `.gitignore` is the
 * primary control and this is the check that the ban held.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..', '..');

/** Every path git is tracking, at the working tree's tip. */
function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

/**
 * `KEY=value` where the value is a plausible secret rather than a placeholder.
 *
 * The placeholder test is what makes this usable: `.env.example` exists to
 * list these exact key names, and a guard that cannot tell `sk-abc123…` from
 * `your-key-here` would either fail on the example file forever or be deleted.
 */
const SECRET_KEY = /(?:^|\n)\s*(?:export\s+)?([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|DSN)[A-Z0-9_]*)\s*=\s*["']?([^\s"'\n#]{12,})/g;

/** Values that are documentation, not credentials. */
const PLACEHOLDER =
  /^(?:your|my|the|a)[-_]|(?:[-_]your[-_]|xxx|placeholder|example|changeme|change[-_]me|change[-_]this|replace[-_]me|dummy|sample|todo|fixme|<[^>]*>|\.\.\.|\*{3,})/i;

/** Credential formats that are recognisable on sight, placeholder or not. */
const KNOWN_PREFIX: Array<[RegExp, string]> = [
  [/\bfc-[a-f0-9]{20,}/, 'Firecrawl API key'],
  [/\bsk-[A-Za-z0-9]{20,}/, 'OpenAI-style secret key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bghp_[A-Za-z0-9]{30,}/, 'GitHub personal access token'],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, 'JWT with a signature'],
];

/** A file whose whole purpose is to hold real environment values. */
const isDotEnv = (path: string) => {
  const base = path.split('/').pop() ?? '';
  return /^\.env(\.|$)/.test(base) && !/\.(example|sample|template)$/.test(base);
};

interface Finding { where: string; what: string }

function inspect(where: string, body: Buffer): Finding[] {
  // A binary blob that is not an archive has no credential this guard can
  // read, and scanning it produces noise rather than findings.
  if (body.includes(0) && !where.endsWith('(zip)')) return [];
  const text = body.toString('utf8');
  const found: Finding[] = [];

  for (const [re, what] of KNOWN_PREFIX) {
    if (re.test(text)) found.push({ where, what });
  }
  for (const m of text.matchAll(SECRET_KEY)) {
    const [, name, value] = m;
    if (PLACEHOLDER.test(value!)) continue;
    // A URL is a locator, not a credential; several of these names hold one.
    if (/^https?:\/\//.test(value!)) continue;
    found.push({ where, what: `${name} assigned a non-placeholder value` });
  }
  return found;
}

test('no tracked file is an archive', () => {
  // The primary control. Two of the three `!` exceptions that used to sit in
  // `.gitignore` carried a live `.env`, and an archive is unreviewable in a
  // diff — so the answer is that none are tracked, rather than that the ones
  // tracked are believed clean.
  const archives = trackedFiles().filter((p) =>
    /\.(zip|tar|tar\.gz|tgz|gz|7z|rar|jar)$/i.test(p));
  assert.deepEqual(archives, [],
    'These are tracked and cannot be reviewed as text. Unpack what is needed ' +
    'into the tree, or leave them untracked — `.gitignore` excludes archives ' +
    `with no exceptions: ${archives.join(', ')}`);
});

test('no tracked file is a real .env', () => {
  const envs = trackedFiles().filter(isDotEnv);
  assert.deepEqual(envs, [],
    `a .env belongs in the deployment, not the repo: ${envs.join(', ')}`);
});

test('no tracked text file carries a credential', () => {
  const findings: Finding[] = [];
  for (const p of trackedFiles()) {
    const abs = join(REPO, p);
    if (!existsSync(abs)) continue;              // a submodule or broken link
    let body: Buffer;
    try { body = readFileSync(abs); } catch { continue; }
    if (body.length > 4_000_000) continue;
    // This test file quotes the key names it looks for, in prose.
    if (p.endsWith('test/committedSecrets.test.ts')) continue;
    findings.push(...inspect(p, body));
  }
  assert.deepEqual(findings, [],
    'Rotate anything real at the vendor first — removing it here does not ' +
    'undo the disclosure — then take it out of the file:\n' +
    findings.map((f) => `  ${f.where}: ${f.what}`).join('\n'));
});

test('the guard can actually see inside an archive', () => {
  // The archive ban above means this test has nothing live to look at, and a
  // check with nothing to check is one that quietly stops working. So the
  // detector is exercised directly, on the two shapes that were really in the
  // tracked zips, plus the placeholder that must not trip it.
  const leak = Buffer.from(
    'TRADIER_API_KEY=e9dREDACTEDbutRealLooking123\n' +
    'FIRECRAWL_API_KEY=fc-0123456789abcdef0123456789\n',
  );
  const whats = inspect('x.zip!/.env (zip)', leak).map((f) => f.what);
  assert.ok(whats.some((w) => w.includes('Firecrawl')), 'missed the fc- key');
  assert.ok(whats.some((w) => w.startsWith('TRADIER_API_KEY')), 'missed the assignment');

  // The real `.env.example`, whose Firecrawl line caught this guard out on
  // first run: `fc-your-firecrawl-api-key` wears a real key's prefix, so the
  // placeholder test cannot be anchored to the start of the value.
  const example = Buffer.from(
    'TRADIER_API_KEY=your-tradier-key-here\n' +
    'FIRECRAWL_API_KEY=fc-your-firecrawl-api-key\n' +
    'POLYGON_API_KEY=changeme\n' +
    'SUPABASE_URL=https://example.supabase.co\n' +
    'NEXTAUTH_SECRET=<generate-with-openssl-rand>\n',
  );
  assert.deepEqual(inspect('.env.example', example), [],
    '.env.example must stay checkable — a guard that fails on it gets deleted');
});

test('.gitignore has no archive exception', () => {
  // The mechanism, not just the outcome. `!qf-firecrawl (1).zip` was added by
  // someone who wanted the file available, and it is how this happened; a
  // future one would re-open the same door without tripping the tracked-file
  // test until the moment a zip is committed.
  const lines = readFileSync(join(REPO, '.gitignore'), 'utf8')
    .split('\n').map((l) => l.trim())
    .filter((l) => l.startsWith('!'));
  const archiveExceptions = lines.filter((l) =>
    /\.(zip|tar|tar\.gz|tgz|gz|7z|rar|jar)$/i.test(l));
  assert.deepEqual(archiveExceptions, [],
    `an archive is un-ignored by name again: ${archiveExceptions.join(', ')}`);
});
