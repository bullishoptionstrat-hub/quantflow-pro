#!/usr/bin/env bash
# Wave 8 ML gate. Compiles the service and runs the promotion/training-gate tests.
#
# pytest is a dev dependency (ml-service/requirements-dev.txt). If it is missing
# this FAILS with an actionable message rather than skipping silently — a gate
# that quietly does nothing is worse than no gate.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="${PYTHON:-python3}"

echo "==> byte-compiling ml-service"
"$PY" -m compileall -q "$ROOT/ml-service" || exit 1

if ! "$PY" -c "import pytest" >/dev/null 2>&1; then
  echo "FAIL: pytest is not available to '$PY'."
  echo "      Install dev deps:  $PY -m pip install -r ml-service/requirements-dev.txt"
  echo "      Or point the gate at a venv:  PYTHON=/path/to/venv/bin/python npm run verify:ml"
  exit 1
fi

echo "==> running ML gate tests"
cd "$ROOT/ml-service" && "$PY" -m pytest test_ml_gates.py -q
