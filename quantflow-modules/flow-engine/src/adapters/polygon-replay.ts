/**
 * Polygon.io replay adapter — REST v3 trades + quotes for one contract/day,
 * merged into timestamp order and fed to the FlowEngine.
 *
 * COST HONESTY: Polygon's free options tier does NOT serve real-time trades;
 * as of mid-2026 real-time options effectively starts at the paid Advanced
 * tier, with cheaper tiers delayed. This adapter exists so that the moment a
 * key with options-trades access is available, replay works with zero code
 * changes. Until then, develop against test/fixtures.ts (synthetic).
 * Signals produced through this adapter are marked synthetic=true because
 * replay is not live data.
 */
import { z } from "zod";
import { FlowEngine } from "../engine.js";
import {
  ClassifiedSignal,
  OptionContract,
  OptionQuoteEvent,
  OptionTradeEvent,
} from "../types.js";

const PolyTradeSchema = z.object({
  sip_timestamp: z.number(),            // ns
  price: z.number(),
  size: z.number(),
  exchange: z.number(),
  conditions: z.array(z.number()).optional().default([]),
  id: z.union([z.string(), z.number()]).optional(),
});

const PolyQuoteSchema = z.object({
  sip_timestamp: z.number(),            // ns
  bid_price: z.number(),
  ask_price: z.number(),
});

const PolyPageSchema = z.object({
  results: z.array(z.unknown()).optional().default([]),
  next_url: z.string().optional(),
  status: z.string().optional(),
});

/** OPRA condition 219/ISO-style flags vary; treat condition 227 (ISO) note:
 *  verify against Polygon's options conditions reference before live use. */
const ISO_CONDITION_CODES = new Set([227]);

export interface PolygonReplayOptions {
  apiKey: string;
  /** OCC option symbol WITHOUT the O: prefix, e.g. "SPY260619C00550000". */
  contract: OptionContract;
  /** ISO date, e.g. "2026-06-10". */
  date: string;
  baseUrl?: string;
}

export async function replayPolygonDay(
  engine: FlowEngine,
  opts: PolygonReplayOptions,
): Promise<ClassifiedSignal[]> {
  const base = opts.baseUrl ?? "https://api.polygon.io";
  const ticker = `O:${opts.contract.symbol}`;

  const [trades, quotes] = await Promise.all([
    fetchAll(`${base}/v3/trades/${ticker}?timestamp=${opts.date}&limit=50000`, opts.apiKey),
    fetchAll(`${base}/v3/quotes/${ticker}?timestamp=${opts.date}&limit=50000`, opts.apiKey),
  ]);

  type Ev =
    | { kind: "T"; ts: number; ev: OptionTradeEvent }
    | { kind: "Q"; ts: number; ev: OptionQuoteEvent };

  const events: Ev[] = [];

  for (const raw of quotes) {
    const p = PolyQuoteSchema.safeParse(raw);
    if (!p.success) continue;
    const ts = Math.floor(p.data.sip_timestamp / 1e6);
    events.push({
      kind: "Q", ts,
      ev: { ts, contractSymbol: opts.contract.symbol, bid: p.data.bid_price, ask: p.data.ask_price },
    });
  }

  let i = 0;
  for (const raw of trades) {
    const p = PolyTradeSchema.safeParse(raw);
    if (!p.success) continue;
    const ts = Math.floor(p.data.sip_timestamp / 1e6);
    events.push({
      kind: "T", ts,
      ev: {
        id: String(p.data.id ?? `poly_${ts}_${i++}`),
        ts,
        contract: opts.contract,
        price: p.data.price,
        size: p.data.size,
        exchange: `X${p.data.exchange}`,
        conditions: p.data.conditions,
        iso: p.data.conditions.some((c) => ISO_CONDITION_CODES.has(c)),
      },
    });
  }

  // Quotes before trades at identical timestamps so side inference sees NBBO.
  events.sort((a, b) => a.ts - b.ts || (a.kind === "Q" ? -1 : 1));

  const signals: ClassifiedSignal[] = [];
  for (const e of events) {
    if (e.kind === "Q") engine.onQuote(e.ev);
    else signals.push(...engine.onTrade(e.ev));
  }
  signals.push(...engine.flush());
  return signals;
}

async function fetchAll(url: string, apiKey: string): Promise<unknown[]> {
  const out: unknown[] = [];
  let next: string | undefined = url;
  let pages = 0;
  while (next && pages < 50) {
    const sep = next.includes("?") ? "&" : "?";
    const res: Response = await fetch(`${next}${sep}apiKey=${apiKey}`);
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "Polygon rejected the key for this endpoint — options trades/quotes require a paid options plan.",
      );
    }
    if (!res.ok) throw new Error(`Polygon returned ${res.status} for ${next}`);
    const parsed = PolyPageSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error(`Polygon page failed validation: ${parsed.error.message}`);
    out.push(...parsed.data.results);
    next = parsed.data.next_url;
    pages++;
  }
  return out;
}
