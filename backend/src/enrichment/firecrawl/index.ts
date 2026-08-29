/**
 * Vendored from `quantflow-modules/firecrawl/src/services/firecrawl/`.
 *
 * The module is ESM; this backend is CJS. As with `src/flow-engine/`, the
 * sources are copied rather than imported, with relative-import extensions
 * stripped. Apart from those extensions the files are byte-identical to the
 * module — **change one, mirror it to the other**, or the module stops being a
 * valid description of what ships.
 */
export { FirecrawlClient } from "./client";
export type { ScrapeOptions, SearchOptions } from "./client";
export {
  EnrichmentService,
  InMemoryCache,
} from "./enrichment.service";
export type { CacheStore, EnrichmentServiceOptions } from "./enrichment.service";
export {
  FirecrawlError,
  FirecrawlConfigSchema,
} from "./types";
export type {
  FirecrawlConfig,
  FirecrawlErrorCode,
  EnrichedDocument,
  NewsContextItem,
  ScrapeData,
  SearchResultItem,
} from "./types";
