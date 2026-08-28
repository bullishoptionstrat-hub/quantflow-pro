/**
 * RUNTIME MODE — simulation quarantine.
 *
 * THE DEFECT THIS EXISTS TO PREVENT
 * ---------------------------------
 * backend/src/ingestion/index.ts contains, verbatim:
 *
 *     sources['simulation'] = 'connected';
 *
 * alongside generateSyntheticGEX(), addDarkPoolPrints(), seedInitialData() and
 * generateFlowFromSpot(symbol, spot, 'simulation'). When the Tradier token is
 * absent the service logs "No token — skipping WebSocket, using simulation" and
 * then serves invented flow, invented GEX and invented "dark pool prints"
 * through the same routes and the same socket channel as real data.
 *
 * There is no mode flag gating any of it. That is the single most dangerous
 * defect in the repository, because the failure is invisible: the product looks
 * MORE alive when the data source is broken.
 */

export type RuntimeMode =
  | "PRODUCTION_REAL"
  | "DEVELOPMENT"
  | "REPLAY"
  | "DEMO"
  | "TEST";

export const RUNTIME_MODES: RuntimeMode[] = [
  "PRODUCTION_REAL",
  "DEVELOPMENT",
  "REPLAY",
  "DEMO",
  "TEST",
];

export class SyntheticDataForbiddenError extends Error {
  constructor(what: string, mode: RuntimeMode) {
    super(
      `Refusing to emit synthetic ${what} in RUNTIME_MODE=${mode}. ` +
        `Synthetic market data is permitted only in DEMO, TEST and REPLAY.`
    );
    this.name = "SyntheticDataForbiddenError";
  }
}

/**
 * Resolve the mode from the environment. Defaults to PRODUCTION_REAL, i.e.
 * the SAFE option: an unset or misspelled value forbids synthetic data rather
 * than permitting it. Fail closed, never open.
 */
export function resolveRuntimeMode(env: NodeJS.ProcessEnv = process.env): RuntimeMode {
  const raw = (env.RUNTIME_MODE ?? "").trim().toUpperCase();
  if ((RUNTIME_MODES as string[]).includes(raw)) return raw as RuntimeMode;
  if (raw !== "") {
    // Unrecognised value is a config error, not a licence to improvise.
    throw new Error(
      `Invalid RUNTIME_MODE="${raw}". Expected one of: ${RUNTIME_MODES.join(", ")}`
    );
  }
  return "PRODUCTION_REAL";
}

/** Only these modes may produce data that did not come from a real provider. */
export function syntheticDataAllowed(mode: RuntimeMode): boolean {
  return mode === "DEMO" || mode === "TEST" || mode === "REPLAY";
}

/**
 * Call this at every synthetic generation site. It throws rather than returns
 * false, so a caller cannot ignore the return value and carry on.
 */
export function assertSyntheticAllowed(what: string, mode: RuntimeMode): void {
  if (!syntheticDataAllowed(mode)) throw new SyntheticDataForbiddenError(what, mode);
}
