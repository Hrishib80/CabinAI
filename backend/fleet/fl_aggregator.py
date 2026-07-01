"""
fl_aggregator.py — Track 16: Federated Learning Closed Loop (I5).

Simulates the fleet <-> cloud uncertainty aggregation pipeline:
  1. Each vehicle publishes anonymized drowsiness_uncertainty scores
  2. Aggregator collects them and detects cluster patterns
  3. When pattern detected, generates a threshold_update JSON
  4. Pushes update back to all vehicles via the bus

This is a SIMULATED federated loop (no real ML retraining) that demonstrates
the I5 architecture: fleet uncertainty -> cloud aggregation -> threshold OTA update.
"""
import os
import time
import json
import threading


class FLAggregator:
    _DROWSY_RATIO_THRESHOLD = 0.60
    _BLINK_RATIO_THRESHOLD = 0.40
    _DROWSY_SCORE_TRIGGER = 0.45
    _BLINK_FREQ_TRIGGER = 10.0

    def __init__(self, bus=None, n_vehicles: int = 5):
        self._bus = bus
        self._n_vehicles = n_vehicles
        self._lock = threading.Lock()
        self._vehicle_data: dict = {}
        self._last_update: dict | None = None
        self._current_threshold: float = 0.70
        self._update_count: int = 0

    def collect_uncertainty(self, vehicle_id: str, drowsiness_score: float, blink_freq: float):
        with self._lock:
            self._vehicle_data[vehicle_id] = {
                "drowsiness_score": float(drowsiness_score),
                "blink_freq": float(blink_freq),
                "ts": time.time(),
            }

    def aggregate(self) -> dict | None:
        with self._lock:
            data = dict(self._vehicle_data)

        if not data:
            return None

        n = len(data)
        drowsy_count = sum(
            1 for v in data.values()
            if v["drowsiness_score"] > self._DROWSY_SCORE_TRIGGER
        )
        low_blink_count = sum(
            1 for v in data.values()
            if v["blink_freq"] < self._BLINK_FREQ_TRIGGER
        )

        drowsy_ratio = drowsy_count / n
        blink_ratio = low_blink_count / n

        if drowsy_ratio > self._DROWSY_RATIO_THRESHOLD:
            return {
                "new_threshold": 0.60,
                "reason": "fleet-wide elevated drowsiness",
                "vehicle_count": n,
                "drowsy_ratio": round(drowsy_ratio, 3),
                "triggered_at": time.time(),
            }

        if blink_ratio > self._BLINK_RATIO_THRESHOLD:
            return {
                "new_threshold": 0.55,
                "reason": "fleet-wide low blink frequency",
                "vehicle_count": n,
                "blink_ratio": round(blink_ratio, 3),
                "triggered_at": time.time(),
            }

        return None

    def apply_update(self, update: dict):
        with self._lock:
            self._last_update = update
            self._current_threshold = update.get("new_threshold", self._current_threshold)
            self._update_count += 1

        if self._bus is not None:
            self._bus.publish("FL_THRESHOLD_UPDATE", update)

        self._write_audit_log(update)

    def get_status(self) -> dict:
        with self._lock:
            return {
                "current_threshold": self._current_threshold,
                "last_update": self._last_update,
                "update_count": self._update_count,
                "vehicle_count": len(self._vehicle_data),
                "vehicles": {
                    vid: {
                        "drowsiness_score": v["drowsiness_score"],
                        "blink_freq": v["blink_freq"],
                    }
                    for vid, v in self._vehicle_data.items()
                },
            }

    def _write_audit_log(self, update: dict):
        logs_dir = os.path.join(os.path.dirname(__file__), "..", "..", "logs")
        os.makedirs(logs_dir, exist_ok=True)
        log_path = os.path.join(logs_dir, "fl_audit.log")
        entry = {**update, "written_at": time.time()}
        try:
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\n")
        except Exception as e:
            print(f"[FLAggregator] audit log write error: {e}")
