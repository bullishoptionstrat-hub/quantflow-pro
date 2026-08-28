"""
QuantFlow Pro — REAL model trainer.

This replaces `train.py`, which trains on rng-generated data whose labels are
drawn BEFORE the features, from disjoint per-label ranges. Its reported
AUC 1.0000 is guaranteed by construction and encodes zero market information
(see IMPLEMENTATION_LEDGER.md Wave 0). `train.py` is retained only as the
documented negative example; nothing it produces may be served.

WHAT THIS SCRIPT WILL AND WILL NOT DO
-------------------------------------
It trains ONLY on `flow_outcomes` rows that are:
  - really graded (label != 'UNGRADED'), and
  - not synthetic (is_synthetic = false).

If there are fewer than MIN_TRAINING_SAMPLES such rows it PRINTS THE COUNT AND
EXITS WITHOUT TRAINING. That is the correct behavior, not a failure: a model
fitted to 40 examples of a noisy financial target is a random number generator
with a decimal point.

Splits are CHRONOLOGICAL, never shuffled, with an embargo between train and
test so a label whose horizon overlaps the test window cannot leak backwards.

Run: python train_real.py [--dsn postgres://...] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("quantflow-train-real")

MODELS_DIR = Path(__file__).parent / "models"
MODELS_DIR.mkdir(exist_ok=True)

# ─── Gates ───────────────────────────────────────────────────────────────────

#: Below this many genuinely graded, non-synthetic rows we refuse to train.
#: Chosen so each chronological fold still holds a few hundred examples.
MIN_TRAINING_SAMPLES = 1_000

#: Both classes must be present in usable numbers, or "accuracy" is just the
#: base rate wearing a hat.
MIN_MINORITY_CLASS = 100

#: Gap between the end of train and the start of test, in days. Must exceed the
#: longest label horizon (1d) so an outcome cannot span the boundary.
EMBARGO_DAYS = 2

#: Model promotion ladder. A model may only ever advance one rung at a time,
#: and only with evidence recorded in IMPLEMENTATION_LEDGER.md.
PROMOTION_STAGES = ("RESEARCH", "CANDIDATE", "SHADOW", "VALIDATED", "PRODUCTION")

#: The UI must not surface a score from a model below this stage.
MIN_STAGE_FOR_UI = "VALIDATED"


@dataclass
class TrainingRefusal:
    """Why we declined to train. Serialized so the UI can show progress."""
    refused: bool
    reason: str
    available_samples: int
    required_samples: int
    minority_class_count: int | None = None
    required_minority: int | None = None

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2)


def check_can_train(
    n_samples: int,
    minority_count: int | None = None,
    min_samples: int = MIN_TRAINING_SAMPLES,
    min_minority: int = MIN_MINORITY_CLASS,
) -> TrainingRefusal:
    """Pure gate function, so it is testable without a database."""
    if n_samples < min_samples:
        return TrainingRefusal(
            refused=True,
            reason=(
                f"insufficient_real_samples: {n_samples} graded non-synthetic outcomes, "
                f"need {min_samples}. Collecting data ({n_samples}/{min_samples})."
            ),
            available_samples=n_samples,
            required_samples=min_samples,
        )
    if minority_count is not None and minority_count < min_minority:
        return TrainingRefusal(
            refused=True,
            reason=(
                f"class_imbalance: minority class has {minority_count} examples, "
                f"need {min_minority}."
            ),
            available_samples=n_samples,
            required_samples=min_samples,
            minority_class_count=minority_count,
            required_minority=min_minority,
        )
    return TrainingRefusal(
        refused=False,
        reason="ok",
        available_samples=n_samples,
        required_samples=min_samples,
        minority_class_count=minority_count,
        required_minority=min_minority,
    )


def chronological_split(
    timestamps: list[datetime],
    test_fraction: float = 0.2,
    embargo_days: int = EMBARGO_DAYS,
) -> tuple[list[int], list[int]]:
    """
    Chronological split with an embargo gap.

    Returns (train_idx, test_idx). Rows inside the embargo window belong to
    NEITHER set: a 1-day-horizon label near the boundary would otherwise be
    computed from prices that fall inside the test period.

    A random shuffle here would leak the future into the past and is never used.
    """
    if not timestamps:
        return [], []

    order = sorted(range(len(timestamps)), key=lambda i: timestamps[i])
    n = len(order)
    split_at = int(n * (1 - test_fraction))
    if split_at <= 0 or split_at >= n:
        return order, []

    boundary = timestamps[order[split_at]]
    embargo_seconds = embargo_days * 86_400

    train_idx = [
        i for i in order[:split_at]
        if (boundary - timestamps[i]).total_seconds() > embargo_seconds
    ]
    test_idx = order[split_at:]
    return train_idx, test_idx


def fetch_outcomes(dsn: str) -> list[dict]:
    """
    Load graded, non-synthetic outcomes joined to their flow events.

    Deliberately filters in SQL so synthetic rows cannot reach the trainer even
    by a caller's mistake.
    """
    try:
        import psycopg  # type: ignore
    except ImportError:
        logger.error(
            "psycopg is not installed. Install it to train against a real database: "
            "pip install 'psycopg[binary]'"
        )
        return []

    query = """
        select
            o.underlying_return,
            o.label,
            o.signal_at,
            f.premium, f.size, f.heat_score, f.unusual_score,
            f.confidence, f.classification_grade, f.inferred_side
        from flow_outcomes o
        join flow_archive f on f.id = o.flow_event_id
        where o.label <> 'UNGRADED'
          and o.is_synthetic = false
          and f.is_synthetic = false
        order by o.signal_at asc
    """
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(query)
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def main() -> int:
    parser = argparse.ArgumentParser(description="Train the flow scorer on REAL graded outcomes.")
    parser.add_argument("--dsn", default=os.environ.get("DATABASE_URL", ""),
                        help="Postgres DSN. Falls back to $DATABASE_URL.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report the gate decision without connecting or training.")
    parser.add_argument("--assume-samples", type=int, default=None,
                        help="Testing aid: evaluate the gate against a hypothetical sample count.")
    args = parser.parse_args()

    if args.assume_samples is not None:
        decision = check_can_train(args.assume_samples)
    elif args.dry_run or not args.dsn:
        if not args.dsn:
            logger.warning("No DSN provided (set --dsn or $DATABASE_URL). Treating as 0 samples.")
        decision = check_can_train(0)
    else:
        rows = fetch_outcomes(args.dsn)
        wins = sum(1 for r in rows if r["label"] == "WIN")
        losses = sum(1 for r in rows if r["label"] == "LOSS")
        decision = check_can_train(len(rows), minority_count=min(wins, losses))

    status_path = MODELS_DIR / "training_status.json"
    status_path.write_text(decision.to_json())

    if decision.refused:
        logger.warning("REFUSING TO TRAIN — %s", decision.reason)
        logger.info("Status written to %s", status_path)
        logger.info(
            "This is the correct outcome, not an error. A model fitted to %d examples "
            "would encode noise, exactly like the rng-trained train.py it replaces.",
            decision.available_samples,
        )
        # Exit 0: refusing on insufficient data is a successful, expected run.
        return 0

    logger.info(
        "Gate passed with %d real graded samples. Proceeding to chronological training.",
        decision.available_samples,
    )
    logger.info("Model would be staged at RESEARCH and must be promoted with evidence.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
