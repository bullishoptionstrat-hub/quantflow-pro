/**
 * QuantFlow Terminal — Firecrawl REST client
 *
 * Direct v2 REST integration (no SDK) so it slots into the existing
 * fetch-based Node.js ingest service without dependency churn.
 *
 * Guarantees:
 *  - Every response is schema-validated before it leaves this module.
 *  - 429/5xx/network errors retry with exponential backoff.
 *  - 401/402 fail fast with typed errors (key revoked / out of credits).
 *  - All requests carry a hard timeout.
 */
import {
  FirecrawlConfig,
  FirecrawlConfigSchema,
  FirecrawlError,
  ScrapeData,
  ScrapeResponseSchema,
  SearchResponseSchema,
  SearchResultItem,
} from "./types.js";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface ScrapeOptions {
  formats?: Array<"markdown" | "html" | "links">;
  onlyMainContent?: boolean;
}

export interface SearchOptions {
  limit?: number;
  /** When true, each result includes full-page markdown (costs more credits). */
  scrapeContent?: boolean;
  /** e.g. "qdr:d" style recency is not supported; use tbs per Firecrawl docs. */
  tbs?: string;
}

export class FirecrawlClient {
  private readonly cfg: FirecrawlConfig;

  constructor(config: Partial<FirecrawlConfig> & { apiKey: string }) {
    this.cfg = FirecrawlConfigSchema.parse(config);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): FirecrawlClient {
    const apiKey = env.FIRECRAWL_API_KEY;
    if (!apiKey) {
      throw new FirecrawlError("AUTH", "FIRECRAWL_API_KEY is not set");
    }
    return new FirecrawlClient({ apiKey });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async scrape(url: string, opts: ScrapeOptions = {}): Promise<ScrapeData> {
    const body = {
      url,
      formats: opts.formats ?? ["markdown"],
      onlyMainContent: opts.onlyMainContent ?? true,
    };
    const json = await this.post("/scrape", body);
    const parsed = ScrapeResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new FirecrawlError(
        "BAD_RESPONSE",
        `Scrape response failed validation: ${parsed.error.message}`,
      );
    }
    if (!parsed.data.success || !parsed.data.data) {
      throw new FirecrawlError(
        "UPSTREAM",
        parsed.data.error ?? "Scrape returned success=false with no data",
      );
    }
    return parsed.data.data;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResultItem[]> {
    const body: Record<string, unknown> = {
      query,
      limit: opts.limit ?? 5,
    };
    if (opts.scrapeContent) {
      body.scrapeOptions = { formats: ["markdown"], onlyMainContent: true };
    }
    if (opts.tbs) body.tbs = opts.tbs;

    const json = await this.post("/search", body);
    const parsed = SearchResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new FirecrawlError(
        "BAD_RESPONSE",
        `Search response failed validation: ${parsed.error.message}`,
      );
    }
    if (!parsed.data.success) {
      throw new FirecrawlError("UPSTREAM", parsed.data.error ?? "Search failed");
    }
    const data = parsed.data.data;
    if (!data) return [];
    return Array.isArray(data) ? data : (data.web ?? []);
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async post(path: string, body: unknown): Promise<unknown> {
    let lastErr: FirecrawlError | undefined;

    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      if (attempt > 0) {
        const backoff = this.cfg.retryBackoffMs * 2 ** (attempt - 1);
        await sleep(backoff);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);

      try {
        const res = await fetch(`${this.cfg.baseUrl}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.cfg.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (res.status === 401 || res.status === 403) {
          throw new FirecrawlError("AUTH", "Firecrawl rejected the API key", res.status);
        }
        if (res.status === 402) {
          throw new FirecrawlError(
            "INSUFFICIENT_CREDITS",
            "Firecrawl account is out of credits for this cycle",
            402,
          );
        }
        if (RETRYABLE_STATUS.has(res.status)) {
          lastErr = new FirecrawlError(
            res.status === 429 ? "RATE_LIMIT" : "UPSTREAM",
            `Firecrawl ${path} returned ${res.status}`,
            res.status,
          );
          continue; // retry
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new FirecrawlError(
            "UPSTREAM",
            `Firecrawl ${path} returned ${res.status}: ${text.slice(0, 300)}`,
            res.status,
          );
        }
        return (await res.json()) as unknown;
      } catch (err) {
        if (err instanceof FirecrawlError) {
          if (err.code === "AUTH" || err.code === "INSUFFICIENT_CREDITS") throw err;
          lastErr = err;
          continue;
        }
        if (err instanceof Error && err.name === "AbortError") {
          lastErr = new FirecrawlError("TIMEOUT", `Firecrawl ${path} timed out`);
          continue;
        }
        lastErr = new FirecrawlError(
          "UPSTREAM",
          `Network error calling Firecrawl ${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastErr ?? new FirecrawlError("UPSTREAM", "Firecrawl request failed");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
