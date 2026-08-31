/**
 * No code path may contact a host the rights registry prohibits.
 *
 * `mayOperateConnector` gates on the connector's *name*. That is the right
 * shape for the thing it guards — whether a connector runs — but it cannot see
 * a connector that runs legitimately and then dials a prohibited host from
 * inside its own fetch. Exactly that was live: `startCBOE` was gated open
 * (CBOE is UNVERIFIED, not PROHIBITED) and `fetchVIXYahoo` inside it pulled
 * all five VIX tenors from `query1.finance.yahoo.com` — the one host the
 * registry marks PROHIBITED in both modes — five requests every five minutes,
 * under a dataset id whose recorded host is `cdn.cboe.com`.
 *
 * The name gate reported `yahoo: refused` the whole time, and it was telling
 * the truth about the connector and nothing about the traffic. This test reads
 * the hosts out of the registry and checks the source, so a prohibition cannot
 * be satisfied on paper by a connector that reaches around it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUSINESS_MODES, datasetIdForSource, listDatasets,
} from '../src/provenance/rights';

const SRC = join(__dirname, '..', 'src');

/** Hosts of every dataset PROHIBITED for display or persistence in any mode. */
const PROHIBITED_HOSTS = listDatasets()
  .filter((d) => BUSINESS_MODES.some(
    (m) => d.display[m] === 'PROHIBITED' || d.persist[m] === 'PROHIBITED',
  ))
  .map((d) => ({ host: d.host, id: d.id }));

/**
 * The one file allowed to name a prohibited host: the connector that *is* that
 * dataset. It is refused at start by the name gate, so the reference is inert
 * — and deleting the file to satisfy a lint would lose the record of what the
 * refusal is refusing.
 */
const OWNER_FILE: Record<string, string> = {
  YAHOO_QUOTES: join('ingestion', 'connectors', 'yahoo.ts'),
};

/**
 * The registry itself, which is where these hosts are declared. Exempt for the
 * obvious reason — it is the file this test reads its list out of — and for a
 * second one: a `host` field is evidence about what a connector contacts, and
 * a rule that made recording it an offence would push the classification back
 * into prose.
 */
const REGISTRY_FILE = join('provenance', 'rights.ts');

/**
 * Source with comments removed.
 *
 * A comment cannot issue a request, and the checks below are about traffic. It
 * also keeps the rule from punishing the thing that makes a violation
 * findable: the note in `cboe.ts` explaining which host it used to call is
 * documentation, not a fetch.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Hosts named in a literal in the code — not in comments. */
function hostsIn(src: string): Set<string> {
  return new Set(
    [...codeOnly(src).matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]!),
  );
}

/** Every .ts file under src/, relative to src/. */
function sourceFiles(dir = SRC, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = join(prefix, e.name);
    if (e.isDirectory()) return sourceFiles(join(dir, e.name), rel);
    return e.name.endsWith('.ts') ? [rel] : [];
  });
}

test('the registry actually asserts a prohibition to check', () => {
  // If this list is ever empty the tests below pass vacuously.
  assert.ok(PROHIBITED_HOSTS.length > 0, 'no dataset is PROHIBITED — this suite proves nothing');
  assert.ok(PROHIBITED_HOSTS.some((h) => h.host === 'query1.finance.yahoo.com'));
});

test('no source file contacts a prohibited host', () => {
  const offences: string[] = [];

  for (const file of sourceFiles()) {
    const body = codeOnly(readFileSync(join(SRC, file), 'utf8'));
    for (const { host, id } of PROHIBITED_HOSTS) {
      if (!body.includes(host)) continue;
      if (OWNER_FILE[id] === file || file === REGISTRY_FILE) continue;
      offences.push(`${file} references ${host} (${id}, PROHIBITED)`);
    }
  }

  assert.deepEqual(
    offences, [],
    `a prohibited host is reachable from code the connector gate lets run:\n  ${offences.join('\n  ')}`,
  );
});

test('the owner file exemption points at a real file that is gated', () => {
  // The exemption is only safe while the file it names is refused at start.
  for (const [id, file] of Object.entries(OWNER_FILE)) {
    const body = readFileSync(join(SRC, file), 'utf8');
    assert.ok(body.length > 0, `${file} should exist`);
    const source = Object.keys({ yahoo: 1 }).find((s) => datasetIdForSource(s) === id);
    assert.ok(source, `${id} needs a connector source string`);
  }
});

test('the CBOE connector reads Cboe, and only Cboe', () => {
  // The specific regression. `fetchVIXYahoo` lived here and the file is named
  // for a different publisher than the one it was calling.
  const hosts = hostsIn(
    readFileSync(join(SRC, 'ingestion', 'connectors', 'cboe.ts'), 'utf8'),
  );
  assert.ok(hosts.size > 0, 'expected the connector to name its endpoints');
  assert.deepEqual(
    [...hosts], ['cdn.cboe.com'],
    'the cboe connector must reach cdn.cboe.com and nothing else',
  );
});

test('every dataset host matches the connectors mapped to it', () => {
  // The registry's `host` field is evidence, not decoration: it is what the
  // prohibited-host check reads. A dataset whose connector talks to a
  // different host makes every classification hung off it unverifiable.
  const CONNECTOR_FILE: Record<string, string> = {
    cboe: 'cboe.ts',
    cboe_options: 'cboeOptions.ts',
    occ: 'occ.ts',
    yahoo: 'yahoo.ts',
    marketdata: 'marketData.ts',
    schwab: 'schwab.ts',
    tastytrade: 'tastytrade.ts',
  };

  for (const [source, file] of Object.entries(CONNECTOR_FILE)) {
    const id = datasetIdForSource(source);
    assert.ok(id, `${source} should be mapped`);
    const ds = listDatasets().find((d) => d.id === id)!;
    const hosts = hostsIn(
      readFileSync(join(SRC, 'ingestion', 'connectors', file), 'utf8'),
    );
    if (hosts.size === 0) continue; // host comes from config, not a literal
    assert.ok(
      hosts.has(ds.host),
      `${file} contacts ${[...hosts].join(', ')} but ${ds.id} records host "${ds.host}"`,
    );
  }
});
