# Preview

Run the UI against a captured backend, in about 35MB.

Exercising the frontend normally means running the backend, the ML service and
`next dev` together. That is fine on a workstation and impossible on a
constrained box — the backend is ~320MB of ingestion pipeline, `next dev`
another ~300MB, and a browser on top of both will not fit. This serves the same
pages against the same data out of one small process.

## Use

```bash
# 1. Against a running backend (DEMO_MODE=1), record what it says.
cd backend && DEMO_MODE=1 npm run dev          # in another shell
npm run preview:capture -- --out .preview/cap

# 2. Build the frontend once.
cd ../frontend && npm run build

# 3. Serve both halves from one origin.
cd ../backend && DEMO_MODE=1 npm run preview -- --cap .preview/cap --site ../frontend/.next
```

Then open <http://localhost:3360>.

`DEMO_MODE=1` on step 3 matters: the socket gate is the real
`authenticateSocket`, so without it every socket is refused and the flow page
shows the client's simulated prints instead of the captured feed. The tool says
so at startup rather than leaving you to wonder.

## What is real

- **The pages** are the actual `next build` output, unmodified.
- **The data** is whatever the backend returned, recorded verbatim. Fixtures
  written by hand drift from the API they describe and nobody notices; these
  cannot, because nobody writes them.
- **The gate** is imported from `src/middleware/auth`, not reimplemented. A
  preview that approximated it would be exactly the kind of second copy that
  goes quietly stale, and this repo already has a test suite for that failure.

## What is not

- **Not live.** Prices do not move. Every connector shows the state it had at
  capture time, which is why `manifest.json` records the timestamp and a note
  about the credentials that backend was running with — a snapshot from a
  keyless run and one from a credentialed run look similar and mean very
  different things.
- **No middleware.** The static build serves pages directly, so the Supabase
  session redirect in `middleware.ts` does not run. Pages that would bounce to
  `/login` in production open straight up here. Do not read that as the gate
  being broken.
- **Entitled endpoints are never captured.** `/api/chain` and the enrichment
  routes sit behind plain `requireAuth` because they return vendor data or
  spend metered Firecrawl credits. A fixture of either is a thing that should
  not be sitting in a directory, so `capture.ts` does not ask for them.

## Showing it to someone on ChromeOS

Inside a Crostini container, `xdg-open` is the generic freedesktop script and
fails silently. The handler that reaches the host browser is:

```bash
/opt/google/cros-containers/bin/garcon --client --url "http://localhost:3360/flow/"
```

The page then renders on the host, which also means the container's memory
ceiling does not apply to it.
