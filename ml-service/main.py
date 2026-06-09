"""
QuantFlow Pro — ML Service
FastAPI server exposing unusual flow scoring and sentiment prediction.
Model: GradientBoostingClassifier trained on synthetic historical flow data.
"""
from __future__ import annotations

import os
import logging
from pathlib import Path

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("quantflow-ml")

MODEL_PATH = Path(__file__).parent / "models" / "flow_scorer.pkl"
FALLBACK_MODEL = None  # loaded lazily

app = FastAPI(
    title="QuantFlow Pro ML Service",
    description="Unusual flow scoring, sentiment classification, heat prediction",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ─── Request/Response Models ──────────────────────────────────────────────────

class FlowFeatures(BaseModel):
    symbol: str
    strike: float
    spot_price: float
    expiration_days: int = Field(..., ge=0, le=730)
    call_put: int = Field(..., description="1 for call, 0 for put")
    size: int = Field(..., ge=1)
    premium: float = Field(..., ge=0)
    bid: float = Field(..., ge=0)
    ask: float = Field(..., ge=0)
    iv: float = Field(default=0.3, ge=0, le=5.0)
    open_interest: int = Field(default=1000, ge=0)
    avg_volume: int = Field(default=100, ge=0)


class ScoreResponse(BaseModel):
    unusual_score: float
    sentiment_score: float
    heat_score: float
    prediction: str  # "unusual" | "normal"
    confidence: float
    features_used: int


class BatchFlowFeatures(BaseModel):
    events: list[FlowFeatures]


# ─── Model Loading ────────────────────────────────────────────────────────────

def load_model():
    global FALLBACK_MODEL
    if MODEL_PATH.exists():
        try:
            FALLBACK_MODEL = joblib.load(MODEL_PATH)
            logger.info("Loaded trained model from %s", MODEL_PATH)
            return FALLBACK_MODEL
        except Exception as e:
            logger.warning("Failed to load model: %s — using heuristics", e)
    logger.info("No trained model found — using heuristic scorer")
    return None


model = load_model()


# ─── Scoring Logic ────────────────────────────────────────────────────────────

def extract_features(f: FlowFeatures) -> np.ndarray:
    """Extract numeric feature vector from flow event."""
    moneyness = (f.strike - f.spot_price) / max(f.spot_price, 1)
    bid_ask_spread = (f.ask - f.bid) / max((f.bid + f.ask) / 2, 0.01)
    fill_ratio = 0.5  # assume mid-fill if not provided
    vol_oi_ratio = f.size / max(f.open_interest, 1)
    size_norm = np.log1p(f.size)
    premium_norm = np.log1p(f.premium)
    dte_norm = f.expiration_days / 365.0

    return np.array([
        moneyness,
        bid_ask_spread,
        fill_ratio,
        vol_oi_ratio,
        size_norm,
        premium_norm,
        dte_norm,
        f.call_put,
        f.iv,
        f.size / max(f.avg_volume, 1),
    ], dtype=np.float32)


def heuristic_score(f: FlowFeatures) -> ScoreResponse:
    """Rule-based scoring fallback when no trained model is available."""
    features = extract_features(f)
    vol_oi_ratio = features[3]
    size_norm = features[4]
    premium_norm = features[5]
    bid_ask = features[1]
    iv = f.iv

    # Unusual score: weighted combo of vol/OI, size, premium, IV
    unusual = min(100.0, (
        vol_oi_ratio * 40 +
        min(size_norm * 5, 20) +
        min(premium_norm * 2, 20) +
        min(iv * 10, 20)
    ))

    # Heat score: bid/ask tightness + size + premium
    heat = min(100.0, (
        max(0, 40 - bid_ask * 200) +
        min(size_norm * 6, 30) +
        min(premium_norm * 2.5, 30)
    ))

    # Sentiment score: call bullish, put bearish, magnitude by heat
    if f.call_put == 1:
        sentiment = 50 + heat * 0.5
    else:
        sentiment = 50 - heat * 0.5
    sentiment = max(0, min(100, sentiment))

    confidence = min(0.99, 0.5 + (unusual / 200))
    prediction = "unusual" if unusual >= 65 else "normal"

    return ScoreResponse(
        unusual_score=round(unusual, 2),
        sentiment_score=round(sentiment, 2),
        heat_score=round(heat, 2),
        prediction=prediction,
        confidence=round(confidence, 4),
        features_used=len(features),
    )


def model_score(f: FlowFeatures) -> ScoreResponse:
    """Score using trained GradientBoosting model."""
    features = extract_features(f).reshape(1, -1)
    try:
        proba = model.predict_proba(features)[0]
        unusual_prob = proba[1] if len(proba) > 1 else proba[0]
        unusual_score = round(unusual_prob * 100, 2)
        prediction = "unusual" if unusual_prob >= 0.65 else "normal"

        # Derived scores
        heat = round(min(100, unusual_score * 0.85 + np.log1p(f.size) * 3), 2)
        sentiment = round(
            (50 + heat * 0.5) if f.call_put == 1 else (50 - heat * 0.5), 2
        )

        return ScoreResponse(
            unusual_score=unusual_score,
            sentiment_score=max(0, min(100, sentiment)),
            heat_score=heat,
            prediction=prediction,
            confidence=round(float(unusual_prob), 4),
            features_used=features.shape[1],
        )
    except Exception as e:
        logger.warning("Model predict failed: %s — falling back to heuristics", e)
        return heuristic_score(f)


def score_event(f: FlowFeatures) -> ScoreResponse:
    if model is not None:
        return model_score(f)
    return heuristic_score(f)


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model_loaded": model is not None,
        "model_path": str(MODEL_PATH),
        "version": "1.0.0",
    }


@app.post("/score", response_model=ScoreResponse)
async def score_flow(features: FlowFeatures):
    """Score a single flow event for unusualness and sentiment."""
    try:
        return score_event(features)
    except Exception as e:
        logger.error("Score error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/score/batch")
async def score_batch(batch: BatchFlowFeatures):
    """Score multiple flow events in one request."""
    if len(batch.events) > 100:
        raise HTTPException(status_code=400, detail="Max 100 events per batch")
    results = [score_event(f).model_dump() for f in batch.events]
    return {"results": results, "count": len(results)}


@app.get("/symbols/heat")
async def symbols_heat():
    """Return mock heat scores per symbol (requires live flow data integration)."""
    symbols = ["SPY", "QQQ", "NVDA", "AAPL", "TSLA", "MSFT", "AMD", "MSTR"]
    import random
    return {
        "scores": {
            sym: round(random.uniform(40, 95), 1) for sym in symbols
        }
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("ML_PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
