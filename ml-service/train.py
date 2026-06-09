"""
QuantFlow Pro — ML Model Trainer
Trains a GradientBoostingClassifier on synthetic + historical data.
Run: python train.py
Output: models/flow_scorer.pkl
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import classification_report, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("quantflow-train")

MODELS_DIR = Path(__file__).parent / "models"
MODELS_DIR.mkdir(exist_ok=True)
OUTPUT_PATH = MODELS_DIR / "flow_scorer.pkl"

# ─── Synthetic Data Generation ────────────────────────────────────────────────

def generate_training_data(n_samples: int = 10_000) -> pd.DataFrame:
    """
    Generate synthetic options flow training data.
    Labels: 1 = unusual (institutional sweep), 0 = normal retail flow
    """
    rng = np.random.default_rng(42)

    records = []
    for _ in range(n_samples):
        is_unusual = rng.random() < 0.25  # 25% unusual

        if is_unusual:
            # Institutional characteristics: large size, high OI ratio, tight bid/ask
            size = int(rng.integers(200, 5000))
            oi = int(rng.integers(500, 20000))
            vol_oi_ratio = rng.uniform(0.05, 2.0)
            bid_ask_spread = rng.uniform(0.001, 0.05)
            iv = rng.uniform(0.2, 0.8)
            moneyness = rng.normal(0, 0.03)
            expiration_days = int(rng.integers(1, 45))
            premium = rng.uniform(50_000, 5_000_000)
        else:
            # Retail characteristics: small size, low OI ratio, wide bid/ask
            size = int(rng.integers(1, 100))
            oi = int(rng.integers(100, 50000))
            vol_oi_ratio = rng.uniform(0.0, 0.1)
            bid_ask_spread = rng.uniform(0.02, 0.3)
            iv = rng.uniform(0.15, 1.5)
            moneyness = rng.normal(0, 0.08)
            expiration_days = int(rng.integers(1, 365))
            premium = rng.uniform(100, 50_000)

        call_put = int(rng.choice([0, 1]))
        fill_ratio = rng.uniform(0.0, 1.0)
        size_norm = float(np.log1p(size))
        premium_norm = float(np.log1p(premium))
        dte_norm = expiration_days / 365.0
        size_vol_ratio = size / max(size * 5, 1)

        records.append({
            "moneyness": moneyness,
            "bid_ask_spread": bid_ask_spread,
            "fill_ratio": fill_ratio,
            "vol_oi_ratio": vol_oi_ratio,
            "size_norm": size_norm,
            "premium_norm": premium_norm,
            "dte_norm": dte_norm,
            "call_put": call_put,
            "iv": iv,
            "size_vol_ratio": size_vol_ratio,
            "label": int(is_unusual),
        })

    return pd.DataFrame(records)


# ─── Training ─────────────────────────────────────────────────────────────────

def train():
    logger.info("Generating %d synthetic training samples…", 10_000)
    df = generate_training_data(10_000)

    FEATURES = [
        "moneyness", "bid_ask_spread", "fill_ratio", "vol_oi_ratio",
        "size_norm", "premium_norm", "dte_norm", "call_put", "iv", "size_vol_ratio",
    ]

    X = df[FEATURES].values
    y = df["label"].values

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, stratify=y, random_state=42
    )

    logger.info("Training GradientBoostingClassifier…")
    pipeline = Pipeline([
        ("scaler", StandardScaler()),
        ("clf", GradientBoostingClassifier(
            n_estimators=200,
            max_depth=4,
            learning_rate=0.08,
            subsample=0.8,
            min_samples_leaf=10,
            random_state=42,
            verbose=0,
        )),
    ])

    pipeline.fit(X_train, y_train)

    y_pred = pipeline.predict(X_test)
    y_proba = pipeline.predict_proba(X_test)[:, 1]

    logger.info("\n%s", classification_report(y_test, y_pred, target_names=["normal", "unusual"]))
    logger.info("ROC-AUC: %.4f", roc_auc_score(y_test, y_proba))

    joblib.dump(pipeline, OUTPUT_PATH)
    logger.info("Model saved → %s", OUTPUT_PATH)


if __name__ == "__main__":
    train()
