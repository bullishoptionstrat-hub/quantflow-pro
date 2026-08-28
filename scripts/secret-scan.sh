#!/usr/bin/env bash
# Wave 9 secret scan. Fails the build if a credential-shaped string appears in
# tracked source. Deliberately excludes docs that *describe* the leak (they name
# variables, never values) and the committed zips, which are reported separately
# because their exposure is already recorded in docs/FORENSIC_AUDIT.md #7.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAIL=0

# Credential-shaped patterns. Placeholder forms are excluded by the filter below.
PATTERNS=(
  'eyJ[A-Za-z0-9_-]{30,}'                     # JWT
  'sk-[A-Za-z0-9]{20,}'                       # OpenAI-style
  'AKIA[0-9A-Z]{16}'                          # AWS access key id
  'ghp_[A-Za-z0-9]{30,}'                      # GitHub PAT
  'xox[baprs]-[A-Za-z0-9-]{10,}'              # Slack
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'        # private key
  'postgres(ql)?://[^:]+:[^@\s]+@'            # DSN with inline password
)

echo "==> scanning tracked source for credential-shaped strings"
for pat in "${PATTERNS[@]}"; do
  # Exclude lockfiles (integrity hashes look like secrets) and the audit docs.
  hits=$(git grep -InE "$pat" -- \
        ':!*.lock' ':!*package-lock.json' ':!docs/FORENSIC_AUDIT.md' \
        ':!REPO_AUDIT.md' ':!KNOWN_LIMITATIONS.md' ':!IMPLEMENTATION_LEDGER.md' \
        ':!scripts/secret-scan.sh' 2>/dev/null \
        | grep -viE 'your-|placeholder|example|changeme|dummy|<[a-z_]+>|xxx' || true)
  if [ -n "$hits" ]; then
    echo "POTENTIAL SECRET matching /$pat/:"
    # Print file:line only — never the matched value.
    echo "$hits" | cut -d: -f1,2 | sed 's/^/    /'
    FAIL=1
  fi
done

echo "==> checking no .env file is tracked"
if git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v '\.env\.example' | grep -q .; then
  echo "TRACKED .env FILE:"; git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v '\.env\.example' | sed 's/^/    /'
  FAIL=1
fi

echo "==> reporting archives that may embed credentials"
zips=$(git ls-files '*.zip' || true)
if [ -n "$zips" ]; then
  echo "    NOTE: tracked zip archives present. docs/FORENSIC_AUDIT.md #7 records that two of"
  echo "    them contain REAL credentials which MUST BE ROTATED. Removing the files does not"
  echo "    undo the exposure, since they are already in git history."
  echo "$zips" | sed 's/^/      /'
fi

if [ "$FAIL" -eq 0 ]; then
  echo "==> SECRET SCAN PASSED (no credential-shaped strings in tracked source)"
else
  echo "==> SECRET SCAN FAILED"
fi
exit $FAIL
