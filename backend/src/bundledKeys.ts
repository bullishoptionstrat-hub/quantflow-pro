/**
 * Data-vendor keys, bundled into the source at the owner's explicit request
 * (2026-10-22) so the backend has its data feeds wherever it runs.
 *
 * These are a FALLBACK only: a key already in the environment — Render's
 * dashboard or `backend/.env`, loaded on the line above this import in
 * `server.ts` — always wins. Treat every value here as public: this repo is
 * public, so each one is disclosed and is due for rotation at its vendor.
 * `committedSecrets.test.ts` exempts this file by name, and nothing else.
 */
const BUNDLED: Record<string, string> = {
  POLYGON_API_KEY: "47RJXSijXzC3i3eopVYtdOE7hlpUjFmM",
  FINNHUB_API_KEY: "d7ib3mpr01qu8vfnvvfgd7ib3mpr01qu8vfnvvg0",
  FMP_API_KEY: "UlwwMUkeBUYWfEVU2xeiQE4VouPtkyUY",
  FRED_API_KEY: "0677de2cb2685d643167dd765fc5b05a",
  TWELVE_DATA_API_KEY: "8d88d641b19f48288e493ef164f03681",
  NEWS_API_KEY: "1de7dd08-2bac-46f9-bcc0-ae0bc62b0012",
  EVENT_REGISTRY_API_KEY: "1de7dd08-2bac-46f9-bcc0-ae0bc62b0012",
};

for (const [name, value] of Object.entries(BUNDLED)) {
  if (!process.env[name]) process.env[name] = value;
}
