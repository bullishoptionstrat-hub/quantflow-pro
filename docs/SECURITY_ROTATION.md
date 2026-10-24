# Credential rotation runbook

This repository is public. Any credential that has **ever** been committed —
at the tip, in an old commit, or inside an archive — is disclosed, and
removing it from the tree does not undo that. The only remedy is rotation at
the vendor, which no code here can perform.

The precise inventory (which variables, where they were committed) is
deliberately **not** written in this file or anywhere else in the repository:
the disclosure is not closed until every key is rotated, and a public index of
what leaked where helps exactly one kind of reader. Generate it locally.

## 1. See what has been exposed

```bash
cd backend && npm run security:exposure
```

Walks every blob reachable from every ref, opens zip archives, and prints, per
distinct value: the variable name(s) it was assigned to, a 10-character
SHA-256 **fingerprint**, how many places it appears, and where it first did.
**Values are never printed.** Two names sharing one fingerprint are one key.
Fixtures fabricated as a run of consecutive characters are skipped.

Findings come in two grades. **Key-shaped** values (16+ characters with letters
and digits, or a vendor prefix) are listed first. **Low-confidence** values are
listed separately: a value under a `SECRET` or `PASSWORD` name that is 6–15
characters long or letters-only. A person chose those, so they can be real
secrets — a session-signing secret, an admin password — but they also look like
ordinary configuration. Read each one before rotating on it. Still excluded at
both grades: template defaults (`change-me`, `your-…`), a value that only names
its role (`secret`), dotted code paths (`os.environ.get`), and an unquoted
`NAME: identifier` reference.

Credentials that reached somewhere other than git — a chat transcript, a
screenshot, a support ticket — are not in this report and must be added to the
rotation list by hand.

## 2. Rotate at each vendor

For each name in the report, issue a new key in the vendor's dashboard and
revoke the old one. Then put the new value in:

- `backend/.env` for local runs (gitignored; mode 600; never committed), and
- Render's environment for the deployed service, marked secret.

**Never** in source. `backend/src/bundledKeys.ts` (#87) copied seven vendor
keys into `process.env` from a literal in a public repository and was removed;
`committedSecrets.test.ts` now fails on any module under `backend/src` or
`backend/tools` that assigns into `process.env`, and on the object-literal form
(`NAME: "value"`) the guard previously could not see.

`SUPABASE_SERVICE_KEY` bypasses row-level security. It goes in `backend/.env`
and Render's secret environment only, set by hand, and is never pasted into a
chat, an issue or a PR.

## 3. Verify the old keys are dead

```bash
cd backend && npm run security:verify             # vendors + local files
cd backend && npm run security:verify -- --offline  # local files only
```

- **Local files**: any working-tree file — `.env` files included — still
  holding a value whose fingerprint matches an exposed one. A key rotated at
  the vendor but never replaced locally is listed here.
- **Vendor verdicts**: each exposed value is sent only to the vendor that
  issued it, in one cheap authenticated request, and reported as `REVOKED`,
  `STILL_VALID`, `UNKNOWN` (no clear answer — timeout, rate limit, plan
  refusal) or `NOT_PROBED` (no probe for that variable; confirm in the
  dashboard). The status mappings are the vendors' documented conventions,
  measured for Polygon, Twelve Data and Event Registry; none has yet been run
  against a rotated key. The command exits non-zero while anything is
  `STILL_VALID` or a local file still holds an exposed value.

Run it **after** rotating. Before rotation every key answers `STILL_VALID`.

Note: this sandbox's network policy refuses most vendor hosts, so the vendor
half is meant to be run from a machine that can reach them.

## 4. Things a rotation does not fix

- The Supabase **anon** key is public by design (it ships to every browser).
  Rotating it means rotating the project's JWT secret, which invalidates every
  session; do it only if the project in question is still in use.
- Git history is not rewritten. Rewriting a public history is irreversible,
  breaks every clone, and does not recall copies already made; rotation is the
  control, not deletion.
