/**
 * WAVE 9 — alert storm test. The exit criterion is that dedup provably works.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  AlertGate,
  DEFAULT_POLICY,
  dedupKeyFor,
  severityRank,
  type AlertInput,
} from '../src/alerts/dedup';

const T0 = 1_700_000_000_000;
let gate: AlertGate;
beforeEach(() => { gate = new AlertGate(); });

function alert(over: Partial<AlertInput> = {}): AlertInput {
  return { dedupKey: 'SWEEP|SPY', severity: 'HIGH', message: 'SPY sweep', at: T0, ...over };
}

describe('ALERT STORM — dedup provably works', () => {
  it('1000 identical alerts in one second deliver exactly ONE', () => {
    let delivered = 0;
    for (let i = 0; i < 1000; i++) {
      if (gate.consider(alert({ at: T0 + i })).action === 'deliver') delivered++;
    }
    assert.equal(delivered, 1, 'an alert storm must collapse to a single delivery');
  });

  it('suppressed alerts are COUNTED, not silently dropped', () => {
    for (let i = 0; i < 50; i++) gate.consider(alert({ at: T0 + i }));
    assert.equal(gate.suppressedCount('SWEEP|SPY'), 49);
  });

  it('the next delivery reports how many were folded into it', () => {
    for (let i = 0; i < 10; i++) gate.consider(alert({ at: T0 + i }));
    // Past both the dedup window and the HIGH cooldown (300s).
    const d = gate.consider(alert({ at: T0 + 400_000 }));
    assert.equal(d.action, 'deliver');
    if (d.action === 'deliver') assert.equal(d.suppressedSinceLast, 9);
  });

  it('different keys do NOT dedup against each other', () => {
    let delivered = 0;
    for (const sym of ['SPY', 'QQQ', 'NVDA', 'AAPL']) {
      if (gate.consider(alert({ dedupKey: `SWEEP|${sym}`, at: T0 })).action === 'deliver') delivered++;
    }
    assert.equal(delivered, 4);
  });
});

describe('cooldown', () => {
  it('holds a repeat inside the severity cooldown', () => {
    gate.consider(alert({ at: T0 }));
    const d = gate.consider(alert({ at: T0 + 120_000 })); // past dedup (60s), inside HIGH cooldown (300s)
    assert.equal(d.action, 'suppress');
    if (d.action === 'suppress') assert.equal(d.reason, 'cooldown_active');
  });

  it('allows a repeat after the cooldown elapses', () => {
    gate.consider(alert({ at: T0 }));
    assert.equal(gate.consider(alert({ at: T0 + 301_000 })).action, 'deliver');
  });

  it('ESCALATION breaks the cooldown — new information is not held back', () => {
    gate.consider(alert({ severity: 'MEDIUM', at: T0 }));
    const escalated = gate.consider(alert({ severity: 'CRITICAL', at: T0 + 61_000 }));
    assert.equal(escalated.action, 'deliver', 'a MEDIUM becoming CRITICAL must get through');
  });

  it('DE-escalation does not break the cooldown', () => {
    gate.consider(alert({ severity: 'CRITICAL', at: T0 }));
    const lower = gate.consider(alert({ severity: 'LOW', at: T0 + 61_000 }));
    assert.equal(lower.action, 'suppress');
  });

  it('more severe alerts have shorter cooldowns', () => {
    const c = DEFAULT_POLICY.cooldownMsBySeverity;
    assert.ok(c.CRITICAL < c.HIGH);
    assert.ok(c.HIGH < c.MEDIUM);
    assert.ok(c.MEDIUM < c.LOW);
  });
});

describe('global rate cap sheds the least severe first', () => {
  it('caps deliveries per window', () => {
    let delivered = 0;
    for (let i = 0; i < 100; i++) {
      if (gate.consider(alert({ dedupKey: `K${i}`, severity: 'LOW', at: T0 })).action === 'deliver') {
        delivered++;
      }
    }
    assert.equal(delivered, DEFAULT_POLICY.maxPerWindow);
  });

  it('a CRITICAL still gets through a cap filled with LOW alerts', () => {
    for (let i = 0; i < DEFAULT_POLICY.maxPerWindow; i++) {
      gate.consider(alert({ dedupKey: `K${i}`, severity: 'LOW', at: T0 }));
    }
    const crit = gate.consider(alert({ dedupKey: 'CRIT', severity: 'CRITICAL', at: T0 }));
    assert.equal(crit.action, 'deliver', 'a critical alert must displace a low one');
  });

  it('an equally-low alert does NOT displace another low one', () => {
    for (let i = 0; i < DEFAULT_POLICY.maxPerWindow; i++) {
      gate.consider(alert({ dedupKey: `K${i}`, severity: 'LOW', at: T0 }));
    }
    const another = gate.consider(alert({ dedupKey: 'EXTRA', severity: 'LOW', at: T0 }));
    assert.equal(another.action, 'suppress');
  });

  it('the window rolls, restoring capacity', () => {
    for (let i = 0; i < DEFAULT_POLICY.maxPerWindow; i++) {
      gate.consider(alert({ dedupKey: `K${i}`, severity: 'LOW', at: T0 }));
    }
    const after = gate.consider(alert({ dedupKey: 'LATER', severity: 'LOW', at: T0 + 61_000 }));
    assert.equal(after.action, 'deliver');
  });
});

describe('dedup keys', () => {
  it('the same condition yields the same key', () => {
    const a = dedupKeyFor({ kind: 'SWEEP', symbol: 'SPY', strike: 580, expiry: '2026-09-18' });
    const b = dedupKeyFor({ kind: 'SWEEP', symbol: 'SPY', strike: 580, expiry: '2026-09-18' });
    assert.equal(a, b);
  });

  it('different conditions yield different keys', () => {
    assert.notEqual(
      dedupKeyFor({ kind: 'SWEEP', symbol: 'SPY' }),
      dedupKeyFor({ kind: 'SWEEP', symbol: 'QQQ' }),
    );
  });

  it('severity ranking is ordered most-severe-first', () => {
    assert.ok(severityRank('CRITICAL') < severityRank('HIGH'));
    assert.ok(severityRank('LOW') < severityRank('INFO'));
  });
});
