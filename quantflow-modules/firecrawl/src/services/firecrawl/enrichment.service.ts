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
 * Caching: in-memory TTL cache keyed by URL/query. Swap CacheStore for a
 * Redis adapter in production without touching call sites.
 */
import { createHash } from "node:crypto";
import { FirecrawlClient } from "./client.js";
import { EnrichedDocument, NewsContextItem } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal pluggable cache
// ---------------------------------------------------------------------------

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export class InMemoryCache implements CacheStore {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return hit.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
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
    if (markdown.trim().length === 0) {
      this.log.warn(`[enrichment] Empty markdown for ${url} — treating as unchanged`);
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

    await this.cache.set(cacheKey, JSON.stringify(doc), this.docTtl);
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
