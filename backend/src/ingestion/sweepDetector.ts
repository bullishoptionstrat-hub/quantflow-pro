// Redis-based ISO sweep grouping
// Groups prints that fire on multiple exchanges within a time window into a single SWEEP event

interface PrintRecord {
  underlying: string;
  strike: number;
  expiry: string;
  option_type: 'C' | 'P';
  price: number;
  size: number;
  exchange: string;
  timestamp: number;
}

interface SweepGroup {
  prints: PrintRecord[];
  firstSeen: number;
  lastSeen: number;
  exchanges: Set<string>;
  totalSize: number;
}

// In-memory fallback (use Redis for production)
const sweepGroups = new Map<string, SweepGroup>();
const SWEEP_WINDOW_MS = 2000; // 2 second window
const MIN_EXCHANGES_SWEEP = 2; // min 2 exchanges = SWEEP

export function classifyPrint(print: PrintRecord): { order_type: 'SWEEP' | 'BLOCK' | 'SPLIT'; exchange_count: number; group_size: number } {
  const key = `${print.underlying}|${print.strike}|${print.expiry}|${print.option_type}|${print.price}`;
  const now = Date.now();

  // Expire old groups
  sweepGroups.forEach((g, k) => {
    if (now - g.firstSeen > SWEEP_WINDOW_MS * 2) sweepGroups.delete(k);
  });

  let group = sweepGroups.get(key);
  if (!group || now - group.firstSeen > SWEEP_WINDOW_MS) {
    group = { prints: [], firstSeen: now, lastSeen: now, exchanges: new Set(), totalSize: 0 };
    sweepGroups.set(key, group);
  }

  group.prints.push(print);
  group.exchanges.add(print.exchange);
  group.totalSize += print.size;
  group.lastSeen = now;

  const exchangeCount = group.exchanges.size;
  const isSweep = exchangeCount >= MIN_EXCHANGES_SWEEP;
  const isBlock = print.size >= 500 && !isSweep; // block trade: large single print
  const isSplit = group.prints.length > 1 && !isSweep; // multiple prints, same exchange

  return {
    order_type: isSweep ? 'SWEEP' : isBlock ? 'BLOCK' : isSplit ? 'SPLIT' : 'BLOCK',
    exchange_count: exchangeCount,
    group_size: group.totalSize,
  };
}

export function classifyByPremium(premium: number, exchangeCount: number): 'SWEEP' | 'BLOCK' | 'SPLIT' {
  if (exchangeCount >= 2) return 'SWEEP';
  if (premium >= 500000) return 'BLOCK';
  return 'SPLIT';
}
