"""
Vault Behavioral Anomaly Detector — Isolation Forest on token access patterns.

The Token Vault audit log is a behavioral dataset nobody else generates.
Every time AssistantX requests a scoped token, we record:
  - which connection (gmail, google-drive, github...)
  - which scope (readonly, send, write, admin...)
  - what time of day
  - what day of week
  - how long since last access for this connection
  - request rate over the past hour

An Isolation Forest learns the normal authorization pattern per instance.
Deviations — unusual connection, off-hours scope escalation, abnormal request
bursts — are flagged before the token is issued.

This is only possible because Token Vault exists.
Raw API keys have no audit trail. The vault is not just a credential store.
It is a behavioral sensor.

Design:
  - Min 5 events before scoring begins (cold-start safe)
  - Retrain every RETRAIN_INTERVAL new events
  - contamination=0.05 (flag ~5% as anomalous — tuned for low FPR)
  - Anomalies are logged at CRITICAL level and attached to the token response
  - The caller decides whether to block or require step-up auth
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger("assistantx.anomaly")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MIN_EVENTS_BEFORE_SCORING = 5    # cold-start: don't score until we have history
RETRAIN_INTERVAL          = 10   # retrain isolation forest every N new events
ANOMALY_SCORE_THRESHOLD   = -0.1 # sklearn IF: scores below this are anomalous
MAX_HISTORY               = 500  # rolling window of events per instance

# ---------------------------------------------------------------------------
# Scope risk map — how sensitive is this scope?
# ---------------------------------------------------------------------------

_SCOPE_RISK: Dict[str, float] = {
    "readonly":          0.0,
    "metadata.readonly": 0.0,
    "drive.metadata":    0.1,
    "gmail.readonly":    0.1,
    "drive.readonly":    0.1,
    "drive.file":        0.6,   # write to specific files
    "gmail.send":        0.7,   # send email as user
    "drive":             0.8,   # full drive access
    "gmail.modify":      0.8,
    "gmail.compose":     0.6,
    "contacts.readonly": 0.2,
    "calendar.readonly": 0.1,
    "calendar.events":   0.4,
    "repo":              0.7,   # github full repo
    "repo:read":         0.2,
    "delete":            0.9,
    "admin":             1.0,
}

_CONNECTION_RISK: Dict[str, float] = {
    "google-oauth2":     0.3,
    "github":            0.6,
    "slack":             0.4,
    "telegram":          0.4,
    "proton":            0.5,
    "s3":                0.7,
    "dropbox":           0.5,
}


def _scope_risk(scopes: List[str]) -> float:
    """Max risk across all requested scopes."""
    if not scopes:
        return 0.0
    risks = []
    for scope in scopes:
        # Match against known suffixes
        risk = 0.2  # default: unknown scope is moderately risky
        for key, val in _SCOPE_RISK.items():
            if key in scope.lower():
                risk = max(risk, val)
        risks.append(risk)
    return max(risks)


def _connection_risk(connection: str) -> float:
    for key, val in _CONNECTION_RISK.items():
        if key in connection.lower():
            return val
    return 0.5  # unknown connection — moderate risk


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class VaultAccessEvent:
    """A single token request recorded for behavioral analysis."""
    instance_id:  str
    connection:   str
    scopes:       List[str]
    timestamp:    float = field(default_factory=time.time)
    trigger:      str   = "normal"  # "normal" | "deadman" | "rearm"

    def features(
        self,
        history: List["VaultAccessEvent"],
    ) -> np.ndarray:
        """
        Extract a 6-dimensional feature vector from this event + its history.

        Features:
          [0] hour_of_day       — 0-23
          [1] day_of_week       — 0-6
          [2] connection_risk   — 0.0-1.0
          [3] scope_risk        — 0.0-1.0
          [4] hours_since_last  — hours since last request for this connection (capped 24)
          [5] requests_per_hour — token requests in the last 60 minutes (capped 20)
        """
        dt = datetime.fromtimestamp(self.timestamp)

        # Time since last request for this specific connection
        same_conn = [
            e for e in history
            if e.connection == self.connection and e.timestamp < self.timestamp
        ]
        if same_conn:
            last_ts = max(e.timestamp for e in same_conn)
            hours_since_last = min((self.timestamp - last_ts) / 3600.0, 24.0)
        else:
            hours_since_last = 24.0  # first time accessing this connection — novel

        # Request rate in the past hour
        one_hour_ago = self.timestamp - 3600
        rate = sum(1 for e in history if e.timestamp > one_hour_ago)

        return np.array([
            dt.hour,
            dt.weekday(),
            _connection_risk(self.connection),
            _scope_risk(self.scopes),
            hours_since_last,
            min(float(rate), 20.0),
        ], dtype=np.float32)


@dataclass
class AnomalyResult:
    """Result of scoring a vault access event."""
    anomalous:  bool
    score:      float          # raw isolation forest score (lower = more anomalous)
    reason:     str            # human-readable explanation
    connection: str
    scopes:     List[str]
    timestamp:  float


# ---------------------------------------------------------------------------
# Detector
# ---------------------------------------------------------------------------

class VaultAnomalyDetector:
    """
    Per-instance Isolation Forest trained on vault token access patterns.

    Lifecycle:
      1. Records every VaultAccessEvent
      2. After MIN_EVENTS_BEFORE_SCORING events, fits an initial model
      3. Retrains every RETRAIN_INTERVAL new events
      4. Scores each new event before the token is issued
    """

    def __init__(self, instance_id: str):
        self.instance_id = instance_id
        self._history:    List[VaultAccessEvent] = []
        self._model       = None   # sklearn IsolationForest
        self._events_since_retrain = 0

    def record_and_score(
        self,
        event: VaultAccessEvent,
    ) -> Optional[AnomalyResult]:
        """
        Record this vault access event, retrain if due, and score it.

        Returns:
          None if not enough history yet (cold start)
          AnomalyResult with anomalous=False for normal events
          AnomalyResult with anomalous=True for flagged events
        """
        history_snapshot = list(self._history)  # snapshot before appending

        # Extract features before recording (uses history up to this point)
        if len(history_snapshot) >= MIN_EVENTS_BEFORE_SCORING:
            features = event.features(history_snapshot)
        else:
            features = None

        # Record the event
        self._history.append(event)
        if len(self._history) > MAX_HISTORY:
            self._history = self._history[-MAX_HISTORY:]

        self._events_since_retrain += 1

        # Retrain if due
        if (
            len(self._history) >= MIN_EVENTS_BEFORE_SCORING
            and self._events_since_retrain >= RETRAIN_INTERVAL
        ):
            self._fit()

        # Score if we have a model and features
        if self._model is None or features is None:
            return None

        return self._score(event, features)

    def _fit(self) -> None:
        """Fit (or refit) the Isolation Forest on current history."""
        try:
            from sklearn.ensemble import IsolationForest

            X = np.stack([
                e.features(self._history[:i])
                for i, e in enumerate(self._history)
                if i >= MIN_EVENTS_BEFORE_SCORING
            ])

            if len(X) < MIN_EVENTS_BEFORE_SCORING:
                return

            self._model = IsolationForest(
                n_estimators=100,
                contamination=0.05,  # expect ~5% anomalies
                random_state=42,
                n_jobs=1,
            )
            self._model.fit(X)
            self._events_since_retrain = 0

            logger.info(
                "Anomaly detector retrained on %d events for instance=%s",
                len(X), self.instance_id,
            )
        except Exception as exc:
            logger.warning("Anomaly detector fit failed: %s", exc)

    def _score(
        self,
        event: VaultAccessEvent,
        features: np.ndarray,
    ) -> AnomalyResult:
        """Score a single event against the fitted model."""
        try:
            score = float(self._model.score_samples(features.reshape(1, -1))[0])
            anomalous = score < ANOMALY_SCORE_THRESHOLD

            reason = _explain(event, features, score, anomalous)

            if anomalous:
                logger.critical(
                    "VAULT ANOMALY DETECTED — instance=%s connection=%s "
                    "scopes=%s score=%.3f reason=%s",
                    self.instance_id,
                    event.connection,
                    event.scopes,
                    score,
                    reason,
                )
            else:
                logger.debug(
                    "Vault access normal — instance=%s connection=%s score=%.3f",
                    self.instance_id, event.connection, score,
                )

            return AnomalyResult(
                anomalous=anomalous,
                score=score,
                reason=reason,
                connection=event.connection,
                scopes=event.scopes,
                timestamp=event.timestamp,
            )

        except Exception as exc:
            logger.warning("Anomaly scoring failed: %s", exc)
            return AnomalyResult(
                anomalous=False,
                score=0.0,
                reason="scoring_error",
                connection=event.connection,
                scopes=event.scopes,
                timestamp=event.timestamp,
            )

    def summary(self) -> dict:
        """Return a summary of detector state for the dashboard."""
        return {
            "instance_id":    self.instance_id,
            "events_recorded": len(self._history),
            "model_fitted":   self._model is not None,
            "min_events":     MIN_EVENTS_BEFORE_SCORING,
            "ready":          self._model is not None,
        }


# ---------------------------------------------------------------------------
# Human-readable explanation
# ---------------------------------------------------------------------------

def _explain(
    event:     VaultAccessEvent,
    features:  np.ndarray,
    score:     float,
    anomalous: bool,
) -> str:
    hour, dow, conn_risk, scope_risk, hrs_since_last, rate = features

    reasons = []

    if hrs_since_last >= 20:
        reasons.append(f"first access to {event.connection} (novel connection)")
    elif hrs_since_last > 6:
        reasons.append(
            f"unusual timing: {hrs_since_last:.1f}h since last {event.connection} access"
        )

    if scope_risk >= 0.7:
        reasons.append(
            f"high-risk scope requested: {', '.join(event.scopes)}"
        )

    if hour < 5 or hour >= 23:
        reasons.append(f"off-hours request at {int(hour):02d}:00")

    if rate >= 10:
        reasons.append(f"elevated request rate: {int(rate)} requests in past hour")

    if conn_risk >= 0.7:
        reasons.append(f"high-risk connection type: {event.connection}")

    if not reasons:
        if anomalous:
            reasons.append("unusual combination of access features")
        else:
            reasons.append("normal access pattern")

    return "; ".join(reasons)


# ---------------------------------------------------------------------------
# Registry — one detector per instance
# ---------------------------------------------------------------------------

_detectors: Dict[str, VaultAnomalyDetector] = {}


def get_detector(instance_id: str) -> VaultAnomalyDetector:
    """Get or create the anomaly detector for an instance."""
    if instance_id not in _detectors:
        _detectors[instance_id] = VaultAnomalyDetector(instance_id)
        logger.info("Vault anomaly detector initialised for instance=%s", instance_id)
    return _detectors[instance_id]
