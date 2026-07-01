"""
NPU Health Predictive Model (I3 — Self-Healing AI Pipeline).

Maintains an exponential moving average of three NPU telemetry signals,
classifies current health, and estimates time-to-degradation via linear
extrapolation of the trend.
"""
from collections import deque


class NPUHealthPredictor:
    _ALPHA = 0.1
    _HISTORY_MAX = 20

    _TEMP_CRITICAL = 80.0
    _TEMP_DEGRADING = 65.0
    _BER_CRITICAL = 0.01
    _BER_DEGRADING = 0.005
    _LAT_CRITICAL = 50.0
    _LAT_DEGRADING = 20.0

    _TEMP_NORM = 90.0
    _BER_NORM = 0.02
    _LAT_NORM = 100.0

    def __init__(self):
        self._ema_temp = None
        self._ema_ber = None
        self._ema_lat = None
        self._health_history: deque = deque(maxlen=self._HISTORY_MAX)

    def _update_ema(self, prev, value):
        if prev is None:
            return value
        return self._ALPHA * value + (1 - self._ALPHA) * prev

    def _classify(self, temp, ber, lat):
        if temp > self._TEMP_CRITICAL or ber > self._BER_CRITICAL or lat > self._LAT_CRITICAL:
            return "critical"
        if temp > self._TEMP_DEGRADING or ber > self._BER_DEGRADING or lat > self._LAT_DEGRADING:
            return "degrading"
        return "nominal"

    def _health_score(self, temp, ber, lat):
        raw = 1.0 - max(
            temp / self._TEMP_NORM,
            ber / self._BER_NORM,
            lat / self._LAT_NORM,
        )
        return max(0.0, min(1.0, raw))

    def _trend(self):
        if len(self._health_history) < 10:
            return "stable"
        h = list(self._health_history)
        recent = sum(h[-5:]) / 5
        prev = sum(h[-10:-5]) / 5
        delta = recent - prev
        if delta < -0.02:
            return "worsening"
        if delta > 0.02:
            return "improving"
        return "stable"

    def _predict_degradation(self, health_score, trend):
        if health_score > 0.5 or trend != "worsening":
            return None
        h = list(self._health_history)
        if len(h) < 2:
            return None
        # Rate of change per tick (1 tick = 1 second approx)
        rate = (h[-1] - h[0]) / len(h)
        if rate >= 0:
            return None
        # Ticks until health reaches 0
        ticks_to_zero = -health_score / rate
        # Convert ticks to hours (each tick ~ 1 second)
        hours = round(ticks_to_zero / 3600, 2)
        return hours if hours > 0 else None

    def _swap_recommendation(self, health_score):
        if health_score < 0.3:
            return "Active → Fallback (QWEN 5B INT4)"
        if health_score < 0.6:
            return "Active → Standby (QWEN 6.5B INT8)"
        return None

    def update(self, temp_c: float, ber: float, latency_dev_ms: float) -> dict:
        self._ema_temp = self._update_ema(self._ema_temp, temp_c)
        self._ema_ber = self._update_ema(self._ema_ber, ber)
        self._ema_lat = self._update_ema(self._ema_lat, latency_dev_ms)

        t, b, l = self._ema_temp, self._ema_ber, self._ema_lat
        status = self._classify(t, b, l)
        score = self._health_score(t, b, l)
        self._health_history.append(score)

        trend = self._trend()
        predicted_hours = self._predict_degradation(score, trend)
        swap = self._swap_recommendation(score)

        return {
            "status": status,
            "health_score": round(score, 4),
            "predicted_degradation_hours": predicted_hours,
            "recommended_model_swap": swap,
            "trend_direction": trend,
        }
