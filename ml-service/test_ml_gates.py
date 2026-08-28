"""
WAVE 8 — the ML gates. These prove the model CANNOT reach production or the UI
without real out-of-sample evidence.
"""
from datetime import datetime, timedelta, timezone

import pytest

from model_registry import (
    MIN_OOS_SAMPLES,
    ModelRecord,
    OutOfSampleEvidence,
    PromotionError,
    may_show_in_ui,
    promote,
    ui_placeholder,
)
from train_real import (
    MIN_MINORITY_CLASS,
    MIN_TRAINING_SAMPLES,
    check_can_train,
    chronological_split,
)


def good_evidence(**over):
    base = dict(
        samples=500, split="chronological", auc=0.58, hit_rate=0.55,
        train_end="2026-06-01T00:00:00+00:00", test_start="2026-06-03T00:00:00+00:00",
        embargo_days=2,
    )
    base.update(over)
    return OutOfSampleEvidence(**base)


# ─── Training gate ───────────────────────────────────────────────────────────

def test_refuses_to_train_with_zero_real_samples():
    d = check_can_train(0)
    assert d.refused is True
    assert "insufficient_real_samples" in d.reason
    assert "0/1000" in d.reason  # the UI's "collecting data" string


def test_refuses_just_below_the_threshold():
    d = check_can_train(MIN_TRAINING_SAMPLES - 1)
    assert d.refused is True


def test_allows_at_the_threshold_with_balanced_classes():
    d = check_can_train(MIN_TRAINING_SAMPLES, minority_count=MIN_MINORITY_CLASS)
    assert d.refused is False


def test_refuses_on_class_imbalance_even_with_enough_rows():
    d = check_can_train(10_000, minority_count=5)
    assert d.refused is True
    assert "class_imbalance" in d.reason


# ─── Chronological splitting ─────────────────────────────────────────────────

def _days(n):
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [base + timedelta(days=i) for i in range(n)]


def test_split_is_chronological_not_shuffled():
    ts = _days(100)
    train, test = chronological_split(ts, test_fraction=0.2)
    # every training timestamp precedes every test timestamp
    assert max(ts[i] for i in train) < min(ts[i] for i in test)


def test_embargo_removes_rows_adjacent_to_the_split():
    ts = _days(100)
    no_embargo, _ = chronological_split(ts, test_fraction=0.2, embargo_days=0)
    with_embargo, _ = chronological_split(ts, test_fraction=0.2, embargo_days=5)
    assert len(with_embargo) < len(no_embargo), "embargo must drop boundary rows"


def test_split_handles_empty_input():
    assert chronological_split([]) == ([], [])


# ─── Promotion ladder ────────────────────────────────────────────────────────

def test_cannot_skip_stages():
    m = ModelRecord("m1")
    with pytest.raises(PromotionError, match="cannot skip stages"):
        promote(m, "PRODUCTION", good_evidence())


def test_cannot_reach_validated_without_evidence():
    m = ModelRecord("m1", stage="SHADOW")
    with pytest.raises(PromotionError, match="requires out-of-sample evidence"):
        promote(m, "VALIDATED")


def test_rejects_a_random_shuffle_split():
    m = ModelRecord("m1", stage="SHADOW")
    with pytest.raises(PromotionError, match="chronological"):
        promote(m, "VALIDATED", good_evidence(split="random"))


def test_rejects_too_few_out_of_sample_rows():
    m = ModelRecord("m1", stage="SHADOW")
    with pytest.raises(PromotionError, match="out-of-sample rows"):
        promote(m, "VALIDATED", good_evidence(samples=MIN_OOS_SAMPLES - 1))


def test_rejects_a_perfect_auc_as_implausible():
    """AUC 1.0 is the exact signature of the rng-trained model this replaces."""
    m = ModelRecord("m1", stage="SHADOW")
    with pytest.raises(PromotionError, match="implausible"):
        promote(m, "VALIDATED", good_evidence(auc=1.0))


def test_rejects_test_period_before_train_period():
    m = ModelRecord("m1", stage="SHADOW")
    with pytest.raises(PromotionError, match="not chronological"):
        promote(m, "VALIDATED", good_evidence(
            train_end="2026-06-10T00:00:00+00:00", test_start="2026-06-01T00:00:00+00:00"))


def test_rejects_zero_embargo():
    m = ModelRecord("m1", stage="SHADOW")
    with pytest.raises(PromotionError, match="embargo_days"):
        promote(m, "VALIDATED", good_evidence(embargo_days=0))


def test_valid_promotion_path_works_one_rung_at_a_time():
    m = ModelRecord("m1")
    for stage in ("CANDIDATE", "SHADOW"):
        promote(m, stage)
    promote(m, "VALIDATED", good_evidence())
    assert m.stage == "VALIDATED"
    assert m.evidence is not None
    assert len(m.history) == 3


def test_demotion_is_always_allowed():
    m = ModelRecord("m1", stage="PRODUCTION")
    promote(m, "RESEARCH")
    assert m.stage == "RESEARCH"


# ─── UI gate ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("stage", ["RESEARCH", "CANDIDATE", "SHADOW"])
def test_ui_hides_scores_below_validated(stage):
    assert may_show_in_ui(ModelRecord("m1", stage=stage)) is False


@pytest.mark.parametrize("stage", ["VALIDATED", "PRODUCTION"])
def test_ui_shows_scores_at_validated_and_above(stage):
    assert may_show_in_ui(ModelRecord("m1", stage=stage)) is True


def test_ui_placeholder_reports_progress_not_a_score():
    p = ui_placeholder(ModelRecord("m1"), available=37, required=1000)
    assert p["show_score"] is False
    assert p["message"] == "collecting data (37/1000)"


def test_a_model_cannot_reach_production_without_passing_through_validated():
    """The end-to-end guarantee: no evidence anywhere on the path ⇒ no production."""
    m = ModelRecord("m1")
    promote(m, "CANDIDATE")
    promote(m, "SHADOW")
    with pytest.raises(PromotionError):
        promote(m, "PRODUCTION")   # would skip VALIDATED
    assert m.stage == "SHADOW"
    assert may_show_in_ui(m) is False
