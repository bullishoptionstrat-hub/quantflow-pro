/**
 * Research Workflow #2 — Macro / News Context Digest
 *
 * Pulls recent news snippets for the God's Plan macro regime layer:
 * Fed/rates, CPI/inflation, index futures positioning, and per-symbol
 * headlines for ES/NQ/GC/SI proxies. Writes a dated digest to reports/.
 *
 * HARD RULE (encoded in the output header): this digest is CONTEXT ONLY.
 * It never creates, upgrades, or confirms a trade. Price confirmation
 * rules (sweep/reclaim, break/retest, displacement+retest) always govern.
 *
 * Credit cost per run: 1 search per query (~6 credits, snippets only).
 *
 * Run:
 *   npx tsx scripts/research/macro-digest.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FirecrawlClient,
  FirecrawlError,
  type SearchResultItem,
} from "../../src/services/firecrawl/index.js";

const QUERIES: Array<{ label: string; query: string }> = [
  { label: "Fed / Rates", query: "Federal Reserve interest rate decision outlook" },
  { label: "Inflation / CPI", query: "US CPI inflation latest report" },
  { label: "S&P 500 Futures (ES)", query: "S&P 500 futures market news today" },
  { label: "Nasdaq Futures (NQ)", query: "Nasdaq 100 futures market news today" },
  { label: "Gold (GC)", query: "gold futures price news today" },
  { label: "Silver (SI)", query: "silver futures price news today" },
];

const OUT_DIR = path.resolve("reports");

async function main(): Promise<void> {
  loadDotEnv();
  const client = FirecrawlClient.fromEnv();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const out: string[] = [
    `# Macro / News Context Digest — ${today}`,
    ``,
    `> **Context layer only — never a trade trigger.** Macro regime informs`,
    `> risk posture; bias is earned exclusively through price confirmation`,
    `> (external sweep + reclaim, HTF break + retest + acceptance, or`,
    `> displacement + retest + rejection). Default state: Neutral — waiting.`,
    ``,
  ];

  for (const q of QUERIES) {
    process.stdout.write(`Searching: ${q.label} ... `);
    try {
      const results = await client.search(q.query, { limit: 4, scrapeContent: false });
      out.push(`## ${q.label}`, ``);
      if (results.length === 0) {
        out.push(`_No results._`, ``);
      } else {
        for (const r of results) out.push(formatResult(r));
        out.push(``);
      }
      console.log(`${results.length} results`);
    } catch (err) {
      const msg = err instanceof FirecrawlError ? `${err.code}: ${err.message}` : String(err);
      out.push(`## ${q.label}`, ``, `**FAILED**: ${msg}`, ``);
      console.log(`FAILED — ${msg}`);
      if (err instanceof FirecrawlError && err.code === "INSUFFICIENT_CREDITS") {
        out.push(`> Run aborted: Firecrawl account out of credits.`, ``);
        break;
      }
    }
  }

  out.push(
    `---`,
    ``,
    `## Regime read (manual)`,
    ``,
    `Classify after reviewing sources: risk-on / inflationary / stagflationary / liquidity-supportive.`,
    `Regime never overrides price confirmation.`,
    ``,
    `## Rerun inputs`,
    ``,
    "```",
    `command: npx tsx scripts/research/macro-digest.ts`,
    `queries: ${QUERIES.map((q) => q.label).join(" | ")}`,
    `env: FIRECRAWL_API_KEY`,
    "```",
    ``,
  );

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `macro-digest-${today}.md`);
  await writeFile(outPath, out.join("\n"), "utf8");
  console.log(`\nDigest written: ${outPath}`);
}

function formatResult(r: SearchResultItem): string {
  const title = r.title || r.url;
  const snippet = r.description ? ` — ${r.description.slice(0, 220)}` : "";
  return `- [${title}](${r.url})${snippet}`;
}

function loadDotEnv(): void {
  try {
    const raw = readFileSync(path.resolve(".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      const key = m?.[1];
      const value = m?.[2];
      if (key && value !== undefined && !process.env[key]) {
        process.env[key] = value.trim();
      }
    }
  } catch {
    /* no .env — rely on process env */
  }
}

main().catch((err) => {
  console.error("macro-digest failed:", err);
  process.exitCode = 1;
});
