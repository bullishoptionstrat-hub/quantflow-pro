/**
 * QuantFlow Terminal — Firecrawl integration types
 * Shared between the ingest service and research workflow scripts.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const FirecrawlConfigSchema = z.object({
  apiKey: z
    .string()
    .min(1, "FIRECRAWL_API_KEY is required")
    .startsWith("fc-", "FIRECRAWL_API_KEY must start with fc-"),
  baseUrl: z.string().url().default("https://api.firecrawl.dev/v2"),
  /** Hard timeout per HTTP request (ms). */
  requestTimeoutMs: z.number().int().positive().default(60_000),
  /** Max retries on 429 / 5xx / network errors. */
  maxRetries: z.number().int().min(0).max(5).default(2),
  /** Base backoff (ms); doubles per attempt. */
  retryBackoffMs: z.number().int().positive().default(1_500),
});
export type FirecrawlConfig = z.infer<typeof FirecrawlConfigSchema>;

// ---------------------------------------------------------------------------
// API response shapes (validated — never trust the wire)
// ---------------------------------------------------------------------------

export const ScrapeDataSchema = z.object({
  markdown: z.string().optional(),
  html: z.string().optional(),
  links: z.array(z.string()).optional(),
  metadata: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      sourceURL: z.string().optional(),
      statusCode: z.number().optional(),
    })
    .passthrough()
    .optional(),
});
export type ScrapeData = z.infer<typeof ScrapeDataSchema>;

export const ScrapeResponseSchema = z.object({
  success: z.boolean(),
  data: ScrapeDataSchema.optional(),
  error: z.string().optional(),
});

export const SearchResultItemSchema = z.object({
  url: z.string(),
  title: z.string().optional().default(""),
  description: z.string().optional().default(""),
  markdown: z.string().optional(),
});
export type SearchResultItem = z.infer<typeof SearchResultItemSchema>;

export const SearchResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .union([
      z.array(SearchResultItemSchema),
      z.object({ web: z.array(SearchResultItemSchema).optional() }).passthrough(),
    ])
    .optional(),
  error: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Domain types — what the rest of QuantFlow consumes
// ---------------------------------------------------------------------------

export interface EnrichedDocument {
  source: "firecrawl";
  url: string;
  title: string;
  markdown: string;
  fetchedAt: string; // ISO-8601 UTC
  contentHash: string; // sha256 of markdown — change detection
  statusCode?: number;
}

export interface NewsContextItem {
  url: string;
  title: string;
  snippet: string;
  fetchedAt: string;
}

/** Errors are typed so the ingest service can branch on them. */
export type FirecrawlErrorCode =
  | "AUTH"            // 401/403 — bad or revoked key
  | "RATE_LIMIT"      // 429 after retries exhausted
  | "INSUFFICIENT_CREDITS" // 402
  | "TIMEOUT"
  | "BAD_RESPONSE"    // schema validation failed
  | "UPSTREAM";       // 5xx / network

export class FirecrawlError extends Error {
  constructor(
    public readonly code: FirecrawlErrorCode,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "FirecrawlError";
  }
}
