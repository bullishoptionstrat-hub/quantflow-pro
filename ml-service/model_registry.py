"""
Model promotion ladder.

A model may not appear in the UI as authoritative until it is VALIDATED, and it
cannot reach VALIDATED without out-of-sample evidence. This module makes that a
mechanical rule rather than a policy someone has to remember.

    RESEARCH → CANDIDATE → SHADOW → VALIDATED → PRODUCTION

Rules enforced here:
  1. One rung at a time. No skipping.
  2. Promotion to VALIDATED or beyond REQUIRES out-of-sample evidence with a
     chronological split and a stated sample size.
  3. Demotion to any earlier stage is always allowed (safety valve).
  4. The UI gate is a single function, so no surface can accidentally show an
     unvalidated score as fact.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

STAGES: tuple[str, ...] = ("RESEARCH", "CANDIDATE", "SHADOW", "VALIDATED", "PRODUCTION")

#: Below this stage the UI must show "collecting data", never a score.
MIN_STAGE_FOR_UI = "VALIDATED"

#: A validation claim below this many out-of-sample rows is not evidence.
MIN_OOS_SAMPLES = 200


class PromotionError(Exception):
    """Raised when a promotion would violate the ladder."""


@dataclass
class OutOfSampleEvidence:
    """Evidence backing a promotion. All fields required — no optimistic defaults."""
    samples: int
    split: str                 # must be 'chronological'
    auc: float | None
    hit_rate: float | None
    train_end: str             # ISO
    test_start: str            # ISO
    embargo_days: int

    def problems(self) -> list[str]:
        out: list[str] = []
        if self.split != "chronological":
            out.append(f"split must be 'chronological', got '{self.split}'")
        if self.samples < MIN_OOS_SAMPLES:
            out.append(f"only {self.samples} out-of-sample rows, need {MIN_OOS_SAMPLES}")
        if self.embargo_days < 1:
            out.append("embargo_days must be >= 1 so labels cannot span the split")
        if self.auc is None and self.hit_rate is None:
            out.append("no out-of-sample metric reported")
        if self.auc is not None and not (0.0 <= self.auc <= 1.0):
            out.append(f"auc {self.auc} outside [0,1]")
        # An AUC of exactly 1.0 on financial data is the signature of the bug
        # this whole wave exists to prevent.
        if self.auc is not None and self.auc >= 0.999:
            out.append(
                f"auc {self.auc} is implausible for financial data — "
                "check for label leakage or synthetic inputs"
            )
        try:
            if datetime.fromisoformat(self.test_start) < datetime.fromisoformat(self.train_end):
                out.append("test_start precedes train_end — the split is not chronological")
        except ValueError:
            out.append("train_end/test_start must be ISO timestamps")
        return out


@dataclass
class ModelRecord:
    model_id: str
    stage: str = "RESEARCH"
    evidence: OutOfSampleEvidence | None = None
    history: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.stage not in STAGES:
            raise ValueError(f"unknown stage {self.stage!r}")


def stage_index(stage: str) -> int:
    try:
        return STAGES.index(stage)
    except ValueError as exc:
        raise ValueError(f"unknown stage {stage!r}") from exc


def promote(
    model: ModelRecord,
    to_stage: str,
    evidence: OutOfSampleEvidence | None = None,
    now: datetime | None = None,
) -> ModelRecord:
    """Advance a model one rung. Raises PromotionError on any violation."""
    target = stage_index(to_stage)
    current = stage_index(model.stage)
    ts = (now or datetime.now(timezone.utc)).isoformat()

    # Demotion is always permitted — it can only reduce what users are shown.
    if target < current:
        model.history.append(f"{ts} demoted {model.stage} -> {to_stage}")
        model.stage = to_stage
        return model

    if target == current:
        raise PromotionError(f"model is already at {to_stage}")

    if target != current + 1:
        raise PromotionError(
            f"cannot skip stages: {model.stage} -> {to_stage}. "
            f"Next allowed stage is {STAGES[current + 1]}."
        )

    # Reaching VALIDATED (or beyond) requires real out-of-sample evidence.
    if target >= stage_index("VALIDATED"):
        if evidence is None:
            raise PromotionError(
                f"promotion to {to_stage} requires out-of-sample evidence; none supplied"
            )
        problems = evidence.problems()
        if problems:
            raise PromotionError(f"evidence rejected: {'; '.join(problems)}")
        model.evidence = evidence

    model.history.append(f"{ts} promoted {model.stage} -> {to_stage}")
    model.stage = to_stage
    return model


def may_show_in_ui(model: ModelRecord) -> bool:
    """Single gate. Every UI surface must consult this and nothing else."""
    return stage_index(model.stage) >= stage_index(MIN_STAGE_FOR_UI)


def ui_placeholder(model: ModelRecord, available: int, required: int) -> dict:
    """What the UI shows instead of a score when the model is not validated."""
    return {
        "show_score": False,
        "stage": model.stage,
        "message": f"collecting data ({available}/{required})",
        "reason": (
            f"model is at {model.stage}; scores are hidden until {MIN_STAGE_FOR_UI}"
        ),
    }
