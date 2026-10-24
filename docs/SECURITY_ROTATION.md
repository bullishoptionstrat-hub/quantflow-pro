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
and digits, or a vendor prefix) are listed first, with their fingerprint.
**Low-confidence** values are listed separately: a value under any credential
name (`…KEY`, `…TOKEN`, `…SECRET`, `…PASSWORD`) that is 6–15 characters long or
letters-only. They can be real secrets — a session-signing secret, a hand-set
token — but they also look like ordinary configuration, so read each one before
rotating on it. Their fingerprints are **withheld**: a 10-hex SHA-256 prefix of a
short value can be brute-forced, so printing it would disclose the value.

A value is read whole: a quoted value to its closing quote, an unquoted one up
to whitespace (so a trailing ` # comment` is not part of it), a quote, `,`, `;`,
`|` or a bracket. Base64 and URL characters (`+ / = @ : ~ ! % * # $ & ?
^`) are part of the value, so a base64 secret is graded on its whole length.

Nothing under a credential name is dropped for its length. What is not listed is
**counted by name** at the end of the report: values of 1–5 characters (almost
always test fixtures like `x` or `abc`), digits with no letter (a PIN or a
setting — read it before acting), template defaults (`change-me`, `your-…`, a
value that only names its role such as `secret`), and empty or non-literal
values (`${OTHER}`, `<your-key>`). Not counted at all, because they are not
values: code that reads a value — `process.env.X`, `os.environ.get`, a
constant's name, an unquoted `NAME: identifier`, the unquoted right-hand side
of a `const`/`let`/`var` — and a number under a name that says it is a setting
(`MAX_TOKENS`, `TOKEN_TTL_SECONDS`).

Limits: an unquoted value is read only to its first space, so a passphrase with
spaces is read whole only when quoted; and a quoted sentence under a credential
name can be listed at low confidence.

`security:verify` never probes a low-confidence value: it reports it
`NOT_PROBED` for a person to read first.

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
