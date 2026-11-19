/**
 * The auction / profile detectors (`src/structure/profile.ts`): hand-worked
 * fixtures, the prefix-equals-batch look-ahead guard on seeded walks, the
 * calendar rules (half day, UNKNOWN past coverage), missing volume as null,
 * parameter refusal, and the rules-version pin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bar } from '../src/market/bar';
import {
  DEFAULT_PROFILE_PARAMS, MAX_BINS, PROFILE_RULES_VERSION, ProfileEvent, ProfileParams,
  SessionProfileEvent, detectProfiles, levelsFromProfiles, profileMethodVersionOf,
  profileParamRefusals, resolveProfileParams, singlePrintsOf, valueAreaOf,
} from '../src/structure/profile';
import { detectSweeps } from '../src/structure/sweep';
import { assertPrefixStable, bar, closedBy, et, randomWalks } from './structureFixtures';
import { stripComments } from './zeroDefaults';

const P = { binSize: 1 };
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

function only<K extends ProfileEvent['kind']>(es: ProfileEvent[], kind: K): Extract<ProfileEvent, { kind: K }>[] {
  return es.filter((e) => e.kind === kind) as Extract<ProfileEvent, { kind: K }>[];
}

// ── Pure arithmetic, by hand ─────────────────────────────────────────────────

test('value area: start at the POC, add the larger neighbour, stop at 70%', () => {
  const va = valueAreaOf([1, 2, 5, 3, 1], 100, 1, 0.7);
  assert.deepEqual(va, { pocBin: 102, poc: 102.5, vah: 104, val: 101, total: 12 });
});

test('value area: a tie between neighbours adds both', () => {
  assert.deepEqual(valueAreaOf([2, 5, 2], 0, 1, 1), { pocBin: 1, poc: 1.5, vah: 3, val: 0, total: 9 });
});

test('value area: a tie decides by adding both sides, which can change the edges', () => {
  // both: area 9 -> +3 above -> val 1, vah 5. One side only would stop at val 2.
  assert.deepEqual(valueAreaOf([1, 2, 5, 2, 3], 0, 1, 0.7), { pocBin: 2, poc: 2.5, vah: 5, val: 1, total: 13 });
});

test('value area: stops as soon as the area reaches the target exactly', () => {
  assert.equal(0.7 * 10, 7, 'the fixture relies on an exact product');
  assert.deepEqual(valueAreaOf([1, 2, 4, 3], 0, 1, 0.7), { pocBin: 2, poc: 2.5, vah: 4, val: 2, total: 10 });
});

test('POC ties: nearest the centre wins, then the lower bin', () => {
  assert.equal(valueAreaOf([3, 1, 3], 100, 1, 0.7)?.pocBin, 100, 'equidistant: the lower bin');
  assert.equal(valueAreaOf([3, 3, 1, 1], 100, 1, 0.7)?.pocBin, 101, 'nearer the centre');
});

test('an empty profile has no value area, not a zero one', () => {
  assert.equal(valueAreaOf([0, 0], 0, 1, 0.7), null);
});

test('single prints are interior runs of one; runs at either end are tails', () => {
  assert.deepEqual(singlePrintsOf([2, 1, 1, 3, 1, 2, 1], 100, 1), [{ low: 101, high: 103 }, { low: 104, high: 105 }]);
  assert.deepEqual(singlePrintsOf([1, 2, 1], 0, 1), []);
});

// ── One session by hand ──────────────────────────────────────────────────────

const D = '2026-11-18';
function handSession(vOverride?: (i: number) => number | null): Bar[] {
  const rows: [number, number, number, number][] = [
    // [hour, minute, high, low]
    [9, 30, 101.5, 100.2], [9, 45, 101.2, 100.5], [10, 0, 102.4, 101.1], [10, 15, 102.1, 101.6],
    [10, 30, 103.5, 102.2], [15, 45, 102.9, 99.5],
  ];
  const vols = [40, 20, 30, 10, 20, 60];
  return rows.map(([hh, mm, h, l], i) => {
    const b = bar('SPY', '15m', et(D, hh, mm), (h + l) / 2, h, l, (h + l) / 2);
    return { ...b, v: vOverride ? vOverride(i) : vols[i] };
  });
}

test('hand session: TPO and volume profiles, POC, value area, IB and both extensions', () => {
  const bars = handSession();
  const es = detectProfiles(bars, P);

  const [ib] = only(es, 'INITIAL_BALANCE');
  assert.equal(ib.knownAt, et(D, 10, 30), 'known when the IB ends, not at the session close');
  assert.deepEqual({ ...ib.ib }, { high: 102.4, low: 100.2, endsAt: et(D, 10, 30), status: 'COMPLETE', present: 4, expected: 4 });

  const ext = only(es, 'IB_EXTENSION');
  const up = ext.find((e) => e.direction === 'UP');
  const down = ext.find((e) => e.direction === 'DOWN');
  assert.ok(up && down);
  assert.equal(up.knownAt, et(D, 10, 45));
  assert.ok(close(up.multiple, (103.5 - 102.4) / 2.2));
  assert.equal(down.knownAt, et(D, 16, 0));
  assert.ok(close(down.multiple, (100.2 - 99.5) / 2.2));

  const [p] = only(es, 'SESSION_PROFILE');
  assert.equal(p.knownAt, et(D, 16, 0));
  assert.equal(p.status, 'INCOMPLETE');
  assert.deepEqual(p.coverage.present, 6);
  assert.deepEqual(p.coverage.expected, 26);
  assert.deepEqual(p.bins.map((b) => [b.low, b.tpo]), [[99, 1], [100, 2], [101, 3], [102, 3], [103, 1]]);
  assert.deepEqual(p.tpo, { pocBin: 101, poc: 101.5, vah: 103, val: 100, total: 10 });
  assert.deepEqual(p.bins.map((b) => b.volume), [15, 45, 65, 45, 10]);
  assert.deepEqual(p.volume, { pocBin: 101, poc: 101.5, vah: 103, val: 100, total: 180 });
  assert.equal(p.volumeMissingBars, 0);
  assert.deepEqual(p.singlePrints, []);
  assert.ok(p.ibExtension && close(p.ibExtension.up, 0.5) && close(p.ibExtension.down, 0.7 / 2.2));
  for (const e of es) assert.equal(e.methodVersion, profileMethodVersionOf(resolveProfileParams(P)));
});

test('missing volume is null, never zero: the TPO profile stands and the volume profile does not', () => {
  const es = detectProfiles(handSession((i) => (i === 2 ? null : 10)), P);
  const [p] = only(es, 'SESSION_PROFILE');
  assert.equal(p.volume, null);
  assert.equal(p.volumeMissingBars, 1);
  assert.ok(p.bins.every((b) => b.volume === null));
  assert.equal(p.tpo.poc, 101.5);
  assert.deepEqual(levelsFromProfiles(es, 'VOLUME'), []);
});

test('a real zero volume is data, and is kept as zero', () => {
  const [p] = only(detectProfiles(handSession(() => 0), P), 'SESSION_PROFILE');
  assert.equal(p.volumeMissingBars, 0);
  assert.equal(p.volume, null, 'nothing traded: no POC exists');
  assert.ok(p.bins.every((b) => b.volume === 0));
});

test('the profile is not published before a bar shows the session is over', () => {
  const bars = handSession().slice(0, 5);
  const es = detectProfiles(bars, P);
  assert.equal(only(es, 'SESSION_PROFILE').length, 0);
  assert.equal(only(es, 'INITIAL_BALANCE').length, 1);
});

test('an incomplete IB publishes no extensions and no extension multiple', () => {
  const bars = handSession().filter((_, i) => i !== 1);
  const es = detectProfiles(bars, P);
  assert.equal(only(es, 'INITIAL_BALANCE')[0].ib.status, 'INCOMPLETE');
  assert.equal(only(es, 'IB_EXTENSION').length, 0);
  assert.equal(only(es, 'SESSION_PROFILE')[0].ibExtension, null);
});

// ── The calendar ─────────────────────────────────────────────────────────────

test('half day: the session ends at 13:00 and a later bar is not in the profile', () => {
  const H = '2026-11-27';
  const bars = [
    bar('SPY', '15m', et(H, 9, 30), 100, 101, 100, 100),
    bar('SPY', '15m', et(H, 12, 45), 101.5, 102, 101, 101),
    bar('SPY', '15m', et(H, 13, 0), 100, 140, 90, 100),
  ];
  const [p] = only(detectProfiles(bars, P), 'SESSION_PROFILE');
  assert.equal(p.sessionKind, 'EARLY_CLOSE');
  assert.equal(p.knownAt, et(H, 13, 0));
  assert.equal(p.coverage.closeAt, et(H, 13, 0));
  assert.equal(p.coverage.expected, 14);
  assert.ok(p.bins.every((b) => b.low >= 100 && b.low <= 102), 'the 13:00 bar is outside RTH');
});

test('an IB that would end after a half-day close is not computed', () => {
  const H = '2026-11-27';
  const bars = [
    bar('SPY', '15m', et(H, 9, 30), 100, 101, 100, 100), bar('SPY', '15m', et(H, 12, 45), 101.5, 102, 101, 101),
    // A post-close bar past where a 240-minute IB would end, so a resolver exists.
    bar('SPY', '15m', et(H, 13, 30), 101, 101, 101, 101),
  ];
  assert.equal(only(detectProfiles(bars, { ...P, ibMinutes: 240 }), 'INITIAL_BALANCE').length, 0);
  assert.equal(only(detectProfiles(bars, { ...P, ibMinutes: 60 }), 'INITIAL_BALANCE').length, 1, 'the fixture can produce an IB');
});

test('past the calendar coverage: UNMEASURABLE with the calendar reason, nothing computed', () => {
  const U = '2028-01-03';
  const es = detectProfiles([bar('SPY', '15m', et(U, 9, 30), 100, 101, 100, 100), bar('SPY', '15m', et(U, 15, 45), 100, 101, 100, 100)], P);
  assert.equal(es.length, 1);
  assert.equal(es[0].kind, 'PROFILE_UNMEASURABLE');
  assert.equal(es[0].knownAt, et(U, 9, 45));
});

test('a holiday has no session and no profile', () => {
  const T = '2026-11-26';
  assert.deepEqual(detectProfiles([bar('SPY', '15m', et(T, 9, 30), 100, 101, 100, 100)], P), []);
});

test('a profile wider than MAX_BINS is refused, not allocated', () => {
  const bars = [bar('SPY', '15m', et(D, 9, 30), 100, 100 + MAX_BINS * 0.01 + 1, 100, 100), bar('SPY', '15m', et(D, 15, 45), 100, 101, 100, 100)];
  const es = detectProfiles(bars, { binSize: 0.01 });
  assert.equal(only(es, 'PROFILE_UNMEASURABLE').length, 1);
  assert.equal(only(es, 'SESSION_PROFILE').length, 0);
});

// ── Prior-day value levels for the sweep detector ────────────────────────────

test('prior-day value levels are sweep levels, from COMPLETE profiles only', () => {
  const [a] = randomWalks({ symbols: ['SPY'], tf: '15m', dates: ['2026-11-17', '2026-11-18'], seed: 9, starts: [580] });
  const es = detectProfiles(a, { binSize: 0.25 });
  const levels = levelsFromProfiles(es, 'TPO');
  assert.equal(levels.length, 4);
  assert.deepEqual(levels.map((l) => [l.name, l.side]), [['PD_VAH_TPO', 'HIGH'], ['PD_VAL_TPO', 'LOW'], ['PD_VAH_TPO', 'HIGH'], ['PD_VAL_TPO', 'LOW']]);
  const p = only(es, 'SESSION_PROFILE')[0];
  assert.equal(levels[0].price, p.tpo.vah);
  assert.equal(levels[1].price, p.tpo.val);
  // The sweep detector accepts them and cites them.
  const sweeps = detectSweeps(a, levels);
  for (const s of sweeps) assert.ok(s.knownAt >= s.level.knownAt);
  const partial = detectProfiles(a.filter((_, i) => i !== 3), { binSize: 0.25 });
  assert.equal(levelsFromProfiles(partial, 'TPO').filter((l) => l.knownAt === p.knownAt).length, 0, 'an INCOMPLETE day is no level');
});

// ── Look-ahead ───────────────────────────────────────────────────────────────

const exercised = { kinds: new Set<string>(), singlePrints: 0, nullVolume: 0 };

for (const seed of [1, 7, 42, 2026, 31337]) {
  for (const tf of ['5m', '15m'] as const) {
    test(`look-ahead: seed ${seed} ${tf}, Thanksgiving week, missing bars, missing volume and the coverage edge`, () => {
      const dates = ['2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-30', '2027-12-31', '2028-01-03'];
      const [a] = randomWalks({ symbols: ['SPY'], tf, dates, seed, starts: [580], dropProb: 0.03 });
      // Every 97th bar arrives without volume.
      const bars = a.map((b, i) => (i % 97 === 50 ? { ...b, v: null } : b));
      const params: Partial<ProfileParams> = { binSize: 0.1 };
      const batch = assertPrefixStable(`profile/${seed}/${tf}`, bars.map((b) => b.closedAt), (t) => detectProfiles(closedBy(bars, t), params));
      for (const e of batch) {
        exercised.kinds.add(e.kind);
        if (e.kind === 'SESSION_PROFILE') {
          exercised.singlePrints += e.singlePrints.length;
          if (e.volume === null) exercised.nullVolume++;
        }
      }
    });
  }
}

test('the walks reached every event kind, single prints and a null volume profile', () => {
  assert.deepEqual([...exercised.kinds].sort(), ['IB_EXTENSION', 'INITIAL_BALANCE', 'PROFILE_UNMEASURABLE', 'SESSION_PROFILE']);
  assert.ok(exercised.singlePrints > 0, 'no single print was ever produced');
  assert.ok(exercised.nullVolume > 0, 'no session with missing volume was reached');
});

// ── Parameters and version ───────────────────────────────────────────────────

test('binSize has no default, and bad parameters are refused rather than repaired', () => {
  assert.equal('binSize' in DEFAULT_PROFILE_PARAMS, false);
  assert.throws(() => resolveProfileParams({}), /binSize/);
  const r = (o: Partial<ProfileParams>) => profileParamRefusals({ ...DEFAULT_PROFILE_PARAMS, binSize: 1, ...o });
  assert.deepEqual(r({}), []);
  assert.ok(r({ binSize: 0 }).length === 1);
  assert.ok(r({ binSize: NaN }).length === 1);
  assert.ok(r({ valueAreaPct: 0 }).length === 1);
  assert.ok(r({ valueAreaPct: 1.2 }).length === 1);
  assert.deepEqual(r({ valueAreaPct: 1 }), []);
  assert.ok(r({ tpoMinutes: 0 }).length === 1);
  assert.ok(r({ ibMinutes: 1.5 }).length === 1);
  assert.ok(r({ bogus: 1 } as Partial<ProfileParams>).some((x) => /unknown parameter bogus/.test(x)));
  assert.throws(() => detectProfiles([], { binSize: -1 }));
});

test('every parameter is in the method version', () => {
  const base = resolveProfileParams({ binSize: 1 });
  const v0 = profileMethodVersionOf(base);
  assert.match(v0, /^profile-rules\/1:[0-9a-f]{16}$/);
  const seen = new Set([v0]);
  for (const k of Object.keys(base) as (keyof ProfileParams)[]) {
    const changed = { ...base, [k]: k === 'valueAreaPct' ? 0.8 : base[k] + 1 };
    const v = profileMethodVersionOf(changed);
    assert.ok(!seen.has(v), `changing ${k} did not change the version`);
    seen.add(v);
  }
  assert.equal(seen.size, 5, 'a new parameter must be added here deliberately');
});

const PIN = {
  rulesVersion: 'profile-rules/1',
  sourceSha256: '8e64cd03e40338a2a3420d4ec694fad4e295964de7881f91f7c68f053739a607',
};

test('the profile rules are pinned to PROFILE_RULES_VERSION', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'structure', 'profile.ts'), 'utf8');
  const now = createHash('sha256').update(stripComments(src).replace(/\s+/g, ' ').trim()).digest('hex');
  assert.equal(PROFILE_RULES_VERSION, PIN.rulesVersion, `record ${PROFILE_RULES_VERSION} and hash ${now} in PIN`);
  assert.equal(now, PIN.sourceSha256,
    `profile.ts changed (hash ${now}) while PROFILE_RULES_VERSION is still ${PIN.rulesVersion}: bump it and record the new hash`);
});

test('the profile module is clock-free (the structure purity scan covers it too)', () => {
  const src = stripComments(readFileSync(join(__dirname, '..', 'src', 'structure', 'profile.ts'), 'utf8'));
  assert.ok(!/Date\.now|new Date\(\s*\)|Math\.random|process\./.test(src));
});

// Silence the unused-type lint for SessionProfileEvent: it is the published shape.
export type _Published = SessionProfileEvent;
