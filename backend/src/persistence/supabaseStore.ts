/**
 * QuantFlow Pro — Supabase-backed signal store
 *
 * Mirrors `InMemorySignalStore`'s policy against a real database. The policy
 * is also expressed as constraints in
 * `supabase/migrations/20260829120000_signal_history.sql`, so a write that
 * slips past this file still cannot corrupt the record.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { reconcileWrite } from './identity';
import {
  MIN_PUBLISHABLE_SAMPLE,
  type CollectionGap,
  type OutcomeRecord,
  type SignalRecord,
  type SignalStore,
  type TrackRecordReport,
  type TrackRecordRow,
  type WriteIncident,
  type WriteResult,
} from './types';

const T_SIGNALS = 'signal_history';
const T_OUTCOMES = 'signal_outcomes';
const T_INCIDENTS = 'signal_write_incidents';
const T_GAPS = 'collection_gaps';

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string) => Date.parse(s);

export class SupabaseSignalStore implements SignalStore {
  readonly kind = 'supabase' as const;

  constructor(private readonly db: SupabaseClient) {}

  async writeSignal(rec: SignalRecord): Promise<WriteResult> {
    const existing = await this.getSignal(rec.signalKey);
    const verdict = reconcileWrite(existing, rec);

    if (verdict === 'HISTORY_COLLISION') {
      await this.recordIncident({
        signalKey: rec.signalKey,
        incidentType: 'HISTORY_COLLISION',
        existingContentHash: existing!.contentHash,
        incomingContentHash: rec.contentHash,
        detectedAt: Date.now(),
        note:
          'Same signal key arrived with different content. The stored row was kept ' +
          'and the incoming write refused.',
      });
      return { verdict, signalKey: rec.signalKey };
    }

    if (verdict === 'IDEMPOTENT_REPLAY') {
      return { verdict, signalKey: rec.signalKey };
    }

    const { error } = await this.db.from(T_SIGNALS).insert(toRow(rec));
    if (error) {
      // 23505 = unique violation: another writer inserted between our read and
      // our write. Re-reconcile against what actually landed rather than
      // assuming our row won.
      if (error.code === '23505') {
        const now = await this.getSignal(rec.signalKey);
        const second = reconcileWrite(now, rec);
        if (second === 'HISTORY_COLLISION') {
          await this.recordIncident({
            signalKey: rec.signalKey,
            incidentType: 'HISTORY_COLLISION',
            existingContentHash: now?.contentHash ?? '(unreadable)',
            incomingContentHash: rec.contentHash,
            detectedAt: Date.now(),
            note: 'Concurrent insert on the same key with different content.',
          });
        }
        return { verdict: second, signalKey: rec.signalKey };
      }
      throw new Error(`signal_history insert failed: ${error.message}`);
    }
    return { verdict: 'INSERT', signalKey: rec.signalKey };
  }

  async getSignal(signalKey: string): Promise<SignalRecord | undefined> {
    const { data, error } = await this.db
      .from(T_SIGNALS).select('*').eq('signal_key', signalKey).maybeSingle();
    if (error) throw new Error(`signal_history read failed: ${error.message}`);
    return data ? fromRow(data) : undefined;
  }

  async listUngraded(limit: number): Promise<SignalRecord[]> {
    // Signals with fewer than the full set of live outcomes. Done as two reads
    // rather than a join because PostgREST cannot express the anti-join
    // cleanly and the working set here is small.
    const { data, error } = await this.db
      .from(T_SIGNALS)
      .select('*')
      .eq('synthetic', false)
      .order('decision_at', { ascending: true })
      .limit(limit * 4);
    if (error) throw new Error(`signal_history scan failed: ${error.message}`);
    const rows = (data ?? []).map(fromRow);
    if (rows.length === 0) return [];

    const { data: outs, error: oErr } = await this.db
      .from(T_OUTCOMES)
      .select('signal_key')
      .is('superseded_at', null)
      .in('signal_key', rows.map((r) => r.signalKey));
    if (oErr) throw new Error(`signal_outcomes scan failed: ${oErr.message}`);

    const counts = new Map<string, number>();
    for (const o of outs ?? []) {
      counts.set(o.signal_key, (counts.get(o.signal_key) ?? 0) + 1);
    }
    return rows.filter((r) => (counts.get(r.signalKey) ?? 0) < 4).slice(0, limit);
  }

  async countSignals() {
    const total = await this.count(T_SIGNALS, (q) => q);
    const synthetic = await this.count(T_SIGNALS, (q) => q.eq('synthetic', true));
    return { total, synthetic, real: total - synthetic };
  }

  async writeOutcome(rec: OutcomeRecord): Promise<void> {
    if (rec.label === 'UNGRADED' && !rec.ungradedReason?.trim()) {
      throw new Error(
        `Outcome for ${rec.signalKey}/${rec.horizon} is UNGRADED with no reason.`,
      );
    }
    const { error } = await this.db.from(T_OUTCOMES).insert({
      signal_key: rec.signalKey,
      horizon: rec.horizon,
      label: rec.label,
      excursion: rec.excursion ?? null,
      entry_mark: rec.entryMark ?? null,
      exit_mark: rec.exitMark ?? null,
      due_at: iso(rec.dueAt),
      evaluated_at: iso(rec.evaluatedAt),
      ungraded_reason: rec.ungradedReason ?? null,
      revision: rec.revision,
    });
    // The partial unique index is the real guard: it rejects a second live row
    // for the same (signal, horizon) even if this process raced with itself.
    if (error) throw new Error(`signal_outcomes insert failed: ${error.message}`);
  }

  async listOutcomes(signalKey: string): Promise<OutcomeRecord[]> {
    const { data, error } = await this.db
      .from(T_OUTCOMES).select('*').eq('signal_key', signalKey)
      .order('revision', { ascending: true });
    if (error) throw new Error(`signal_outcomes read failed: ${error.message}`);
    return (data ?? []).map((r): OutcomeRecord => ({
      signalKey: r.signal_key,
      horizon: r.horizon,
      label: r.label,
      excursion: r.excursion ?? undefined,
      entryMark: r.entry_mark ?? undefined,
      exitMark: r.exit_mark ?? undefined,
      dueAt: ms(r.due_at),
      evaluatedAt: ms(r.evaluated_at),
      ungradedReason: r.ungraded_reason ?? undefined,
      revision: r.revision,
    }));
  }

  async recordIncident(inc: WriteIncident): Promise<void> {
    const { error } = await this.db.from(T_INCIDENTS).insert({
      signal_key: inc.signalKey,
      incident_type: inc.incidentType,
      existing_content_hash: inc.existingContentHash,
      incoming_content_hash: inc.incomingContentHash,
      detected_at: iso(inc.detectedAt),
      note: inc.note,
    });
    if (error) throw new Error(`signal_write_incidents insert failed: ${error.message}`);
  }

  async listIncidents(limit: number): Promise<WriteIncident[]> {
    const { data, error } = await this.db
      .from(T_INCIDENTS).select('*')
      .order('detected_at', { ascending: false }).limit(limit);
    if (error) throw new Error(`signal_write_incidents read failed: ${error.message}`);
    return (data ?? []).map((r): WriteIncident => ({
      signalKey: r.signal_key,
      incidentType: r.incident_type,
      existingContentHash: r.existing_content_hash,
      incomingContentHash: r.incoming_content_hash,
      detectedAt: ms(r.detected_at),
      note: r.note,
    }));
  }

  async recordGap(gap: CollectionGap): Promise<void> {
    const { error } = await this.db.from(T_GAPS).upsert({
      id: gap.id,
      kind: gap.kind,
      started_at: iso(gap.startedAt),
      ended_at: iso(gap.endedAt),
      reason: gap.reason,
      source: gap.source ?? null,
    });
    if (error) throw new Error(`collection_gaps upsert failed: ${error.message}`);
  }

  async listGaps(sinceMs: number): Promise<CollectionGap[]> {
    const { data, error } = await this.db
      .from(T_GAPS).select('*').gte('ended_at', iso(sinceMs))
      .order('started_at', { ascending: false });
    if (error) throw new Error(`collection_gaps read failed: ${error.message}`);
    return (data ?? []).map((r): CollectionGap => ({
      id: r.id,
      kind: r.kind,
      startedAt: ms(r.started_at),
      endedAt: ms(r.ended_at),
      reason: r.reason,
      source: r.source ?? undefined,
    }));
  }

  async trackRecord(): Promise<TrackRecordReport> {
    const excluded = {
      synthetic: await this.count(T_SIGNALS, (q) => q.eq('synthetic', true)),
      eventTimeOnlyBasis: await this.count(T_SIGNALS, (q) =>
        q.eq('synthetic', false).eq('decision_basis', 'EVENT_TIME_ONLY')),
      rightsRefused: await this.count(T_SIGNALS, (q) =>
        q.eq('synthetic', false).neq('rights_class', 'PERMITTED')),
    };

    // The research population: real, permitted, observed. Matches the partial
    // index in the migration.
    const { data: sigs, error } = await this.db
      .from(T_SIGNALS).select('signal_key, kind')
      .eq('synthetic', false)
      .eq('rights_class', 'PERMITTED')
      .eq('decision_basis', 'OBSERVED');
    if (error) throw new Error(`track record scan failed: ${error.message}`);

    const kindByKey = new Map<string, string>(
      (sigs ?? []).map((s) => [s.signal_key, s.kind]),
    );

    interface Bucket {
      kind: string; horizon: string;
      nTotal: number; nGraded: number; nUngraded: number;
      hits: number; excursions: number[];
    }
    const buckets = new Map<string, Bucket>();

    if (kindByKey.size > 0) {
      const keys = [...kindByKey.keys()];
      // Chunked: PostgREST builds the IN list into the URL, which has a length
      // limit a large research population would blow past.
      for (let i = 0; i < keys.length; i += 500) {
        const chunk = keys.slice(i, i + 500);
        const { data: outs, error: oErr } = await this.db
          .from(T_OUTCOMES).select('signal_key, horizon, label, excursion')
          .is('superseded_at', null).in('signal_key', chunk);
        if (oErr) throw new Error(`track record outcomes failed: ${oErr.message}`);
        for (const o of outs ?? []) {
          const kind = kindByKey.get(o.signal_key);
          if (!kind) continue;
          const key = `${kind}|${o.horizon}`;
          const b: Bucket = buckets.get(key) ?? {
            kind, horizon: o.horizon,
            nTotal: 0, nGraded: 0, nUngraded: 0, hits: 0, excursions: [],
          };
          b.nTotal++;
          if (o.label === 'UNGRADED') b.nUngraded++;
          else {
            b.nGraded++;
            if (o.label === 'POSITIVE') b.hits++;
            if (o.excursion !== null && o.excursion !== undefined) {
              b.excursions.push(Number(o.excursion));
            }
          }
          buckets.set(key, b);
        }
      }
    }

    const rows: TrackRecordRow[] = [...buckets.values()]
      .map((b) => {
        const row: TrackRecordRow = {
          kind: b.kind,
          horizon: b.horizon as TrackRecordRow['horizon'],
          nTotal: b.nTotal, nGraded: b.nGraded, nUngraded: b.nUngraded,
        };
        if (b.nGraded < MIN_PUBLISHABLE_SAMPLE) {
          row.suppressionReason = 'INSUFFICIENT_SAMPLE';
          return row;
        }
        row.hitRate = b.hits / b.nGraded;
        if (b.excursions.length > 0) {
          const s = [...b.excursions].sort((x, y) => x - y);
          const mid = Math.floor(s.length / 2);
          row.medianExcursion =
            s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
        }
        return row;
      })
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.horizon.localeCompare(b.horizon));

    const notes: string[] = [];
    if (rows.length === 0) {
      notes.push(
        'No real, permitted, forward-observed signal has completed a checkpoint yet.',
      );
    }
    if (excluded.synthetic > 0) {
      notes.push(
        `${excluded.synthetic} synthetic signal(s) excluded — generated by this ` +
        'process, carrying no information about the market.',
      );
    }
    if (excluded.eventTimeOnlyBasis > 0) {
      notes.push(
        `${excluded.eventTimeOnlyBasis} signal(s) excluded for EVENT_TIME_ONLY ` +
        'decision basis, whose decision time credits zero feed latency.',
      );
    }
    if (excluded.rightsRefused > 0) {
      notes.push(
        `${excluded.rightsRefused} signal(s) excluded: source not affirmatively ` +
        'permitted for persistence under the active business mode.',
      );
    }

    return {
      generatedAt: new Date().toISOString(),
      rows, excluded, minSample: MIN_PUBLISHABLE_SAMPLE, notes,
    };
  }

  private async count(
    table: string,
    shape: (q: any) => any,
  ): Promise<number> {
    const { count, error } = await shape(
      this.db.from(table).select('*', { count: 'exact', head: true }),
    );
    if (error) throw new Error(`${table} count failed: ${error.message}`);
    return count ?? 0;
  }
}

// ─── Row mapping ────────────────────────────────────────────────────────────

function toRow(r: SignalRecord) {
  return {
    signal_key: r.signalKey,
    content_hash: r.contentHash,
    engine_id: r.engineId,
    kind: r.kind,
    underlying: r.underlying,
    side: r.side,
    total_premium: r.totalPremium,
    total_size: r.totalSize,
    iso: r.iso,
    score: r.score,
    score_breakdown: r.scoreBreakdown,
    legs: r.legs,
    spread_guess: r.spreadGuess ?? null,
    first_event_at: iso(r.firstEventAt),
    last_event_at: iso(r.lastEventAt),
    decision_at: iso(r.decisionAt),
    decision_basis: r.decisionBasis,
    latency_ms: r.latencyMs,
    source: r.source,
    dataset_id: r.datasetId,
    rights_class: r.rightsClass,
    synthetic: r.synthetic,
    recorded_at: iso(r.recordedAt),
  };
}

function fromRow(d: any): SignalRecord {
  return {
    signalKey: d.signal_key,
    contentHash: d.content_hash,
    engineId: d.engine_id,
    kind: d.kind,
    underlying: d.underlying,
    side: d.side,
    totalPremium: Number(d.total_premium),
    totalSize: Number(d.total_size),
    iso: d.iso,
    score: Number(d.score),
    scoreBreakdown: d.score_breakdown ?? {},
    legs: d.legs ?? [],
    spreadGuess: d.spread_guess ?? undefined,
    firstEventAt: ms(d.first_event_at),
    lastEventAt: ms(d.last_event_at),
    decisionAt: ms(d.decision_at),
    decisionBasis: d.decision_basis,
    latencyMs: d.latency_ms ?? 0,
    source: d.source,
    datasetId: d.dataset_id,
    rightsClass: d.rights_class,
    synthetic: d.synthetic,
    recordedAt: ms(d.recorded_at),
  };
}
