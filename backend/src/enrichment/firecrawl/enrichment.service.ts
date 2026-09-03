/**
 * QuantFlow Terminal — Web Enrichment Service
 *
 * Purpose in the ingest pipeline:
 *   1. fetchFinraNotice()  — pull FINRA regulatory/TRF/ATS pages as clean
 *      markdown with sha256 change detection, so the ingest service only
 *      re-processes a notice when its content actually changed.
 *   2. fetchNewsContext()  — recent news snippets for a ticker/theme.
 *      CONTEXT LAYER ONLY. This output must never be used as a trade
 *      trigger; it feeds the macro/news context panel.
 *
 * Caching: a bounded, in-memory, TTL'd LRU keyed by URL/query. Swap CacheStore
 * for a Redis adapter in production without touching call sites. The bound is
 * not decoration: the news key embeds a caller-supplied query string.
 */
import { createHash } from "node:crypto";
import { FirecrawlClient } from "./client";
import { EnrichedDocument, NewsContextItem } from "./types";

// ---------------------------------------------------------------------------
// Minimal pluggable cache
// ---------------------------------------------------------------------------

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/**
 * Bounded, TTL'd, least-recently-used.
 *
 * This was an unbounded `Map` that only ever deleted a key when that same key
 * was read back after expiry. A key written and never read again stayed for
 * the life of the process — and the news key is
 * `fc:news:${query}:${limit}`, where `query` is a caller-supplied string of up
 * to 200 characters from `/api/sentiment/context?q=`. So a signed-in caller
 * could write a new permanent entry per request, each holding up to ten
 * serialized news items, until the process ran out of memory. On Render's free
 * tier that is 512MB away.
 *
 * `maxEntries` is the cap; expired entries are swept before an eviction is
 * considered, so a cache full of stale keys evicts nothing live. Reads
 * refresh recency, which is what makes the eviction least-recently-*used*
 * rather than merely oldest-written — a hot query must not be evicted by a
 * flood of one-shot ones.
 */
export class InMemoryCache implements CacheStore {
  /** Insertion order in a Map is its LRU order once reads re-insert. */
  private store = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly maxEntries = 500) {}

  async get(key: string): Promise<string | null> {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this.store.delete(key);
      return null;
    }
    // Re-insert to move it to the most-recent end.
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    if (this.store.size <= this.maxEntries) return;

    // Drop what has already expired before evicting anything still live.
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (this.store.size <= this.maxEntries) break;
      if (now > v.expiresAt) this.store.delete(k);
    }
    // Still over: evict from the least-recently-used end.
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }

  /** Entry count, for tests and for anyone wondering what this is holding. */
  get size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface EnrichmentServiceOptions {
  cache?: CacheStore;
  /** TTL for scraped documents (default 6h — FINRA pages change slowly). */
  documentTtlSeconds?: number;
  /** TTL for news searches (default 15m). */
  newsTtlSeconds?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export class EnrichmentService {
  private readonly cache: CacheStore;
  private readonly docTtl: number;
  private readonly newsTtl: number;
  private readonly log: Pick<Console, "info" | "warn" | "error">;

  constructor(
    private readonly client: FirecrawlClient,
    opts: EnrichmentServiceOptions = {},
  ) {
    this.cache = opts.cache ?? new InMemoryCache();
    this.docTtl = opts.documentTtlSeconds ?? 6 * 3600;
    this.newsTtl = opts.newsTtlSeconds ?? 15 * 60;
    this.log = opts.logger ?? console;
  }

  /**
   * Scrape a FINRA (or any regulatory) page into a normalized document.
   * Returns `changed=false` with the cached doc when content hash matches
   * a previously seen hash, so downstream sync jobs can skip re-processing.
   */
  async fetchFinraNotice(
    url: string,
    previousHash?: string,
  ): Promise<{ doc: EnrichedDocument; changed: boolean }> {
    const cacheKey = `fc:doc:${url}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      const doc = JSON.parse(cached) as EnrichedDocument;
      return { doc, changed: previousHash ? doc.contentHash !== previousHash : true };
    }

    const data = await this.client.scrape(url, {
      formats: ["markdown"],
      onlyMainContent: true,
    });

    const markdown = data.markdown ?? "";
    // An empty scrape is a failed scrape. It used to be cached like any other
    // document, so one bad fetch published a document whose `contentHash` is
    // the hash of the empty string — and held it for six hours, during which
    // every caller comparing hashes was told the notice had "changed" to
    // nothing and then stayed that way. A source that is down must not present
    // itself as data.
    if (markdown.trim().length === 0) {
      this.log.warn(`[enrichment] Empty markdown for ${url} — not cached`);
    }

    const doc: EnrichedDocument = {
      source: "firecrawl",
      url,
      title: data.metadata?.title ?? url,
      markdown,
      fetchedAt: new Date().toISOString(),
      contentHash: sha256(markdown),
      statusCode: data.metadata?.statusCode,
    };

    if (markdown.trim().length > 0) {
      await this.cache.set(cacheKey, JSON.stringify(doc), this.docTtl);
    }
    const changed = previousHash ? doc.contentHash !== previousHash : true;
    this.log.info(
      `[enrichment] Fetched ${url} (hash=${doc.contentHash.slice(0, 12)}, changed=${changed})`,
    );
    return { doc, changed };
  }

  /**
   * Recent news context for a symbol or theme.
   * CONTEXT LAYER ONLY — never a trade trigger. Snippets only (no full
   * scrape) to keep credit cost at 1 search per call.
   */
  async fetchNewsContext(query: string, limit = 5): Promise<NewsContextItem[]> {
    const cacheKey = `fc:news:${query}:${limit}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return JSON.parse(cached) as NewsContextItem[];

    const results = await this.client.search(query, { limit, scrapeContent: false });
    const now = new Date().toISOString();
    const items: NewsContextItem[] = results.map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.description,
      fetchedAt: now,
    }));

    await this.cache.set(cacheKey, JSON.stringify(items), this.newsTtl);
    this.log.info(`[enrichment] News context "${query}" → ${items.length} items`);
    return items;
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
