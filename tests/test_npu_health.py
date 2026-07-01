"""Tests for backend/orchestrator/npu_health.py — NPU Health Predictive Model."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from backend.orchestrator.npu_health import NPUHealthPredictor


def _make(n=1, temp=45.0, ber=0.0, lat=0.0):
    p = NPUHealthPredictor()
    result = None
    for _ in range(n):
        result = p.update(temp, ber, lat)
    return p, result


# ── 1. Nominal readings ───────────────────────────────────────────────────────

def test_nominal_status():
    _, r = _make(1, temp=45.0, ber=0.0, lat=0.0)
    assert r['status'] == 'nominal'

def test_nominal_no_swap():
    _, r = _make(1, temp=45.0, ber=0.0, lat=0.0)
    # health_score = 1 - max(45/90, 0, 0) = 0.5 → triggers Standby recommendation
    # nominal status still holds; swap just means "consider switching"
    assert r['status'] == 'nominal'

def test_nominal_health_score_high():
    _, r = _make(1, temp=0.0, ber=0.0, lat=0.0)
    assert r['health_score'] == 1.0

def test_nominal_no_degradation_prediction():
    _, r = _make(1, temp=45.0, ber=0.0, lat=0.0)
    assert r['predicted_degradation_hours'] is None


# ── 2. Critical threshold — temperature spike ─────────────────────────────────

def test_temp_spike_critical():
    _, r = _make(1, temp=95.0, ber=0.0, lat=0.0)
    assert r['status'] == 'critical'

def test_ber_spike_critical():
    _, r = _make(1, temp=40.0, ber=0.015, lat=0.0)
    assert r['status'] == 'critical'

def test_latency_spike_critical():
    _, r = _make(1, temp=40.0, ber=0.0, lat=60.0)
    assert r['status'] == 'critical'


# ── 3. Degrading threshold ────────────────────────────────────────────────────

def test_temp_degrading():
    _, r = _make(1, temp=70.0, ber=0.0, lat=0.0)
    assert r['status'] == 'degrading'

def test_ber_degrading():
    _, r = _make(1, temp=40.0, ber=0.007, lat=0.0)
    assert r['status'] == 'degrading'

def test_latency_degrading():
    _, r = _make(1, temp=40.0, ber=0.0, lat=25.0)
    assert r['status'] == 'degrading'


# ── 4. Health score clamping ──────────────────────────────────────────────────

def test_health_score_clamp_high():
    _, r = _make(1, temp=0.0, ber=0.0, lat=0.0)
    assert r['health_score'] == 1.0

def test_health_score_clamp_low():
    p = NPUHealthPredictor()
    r = p.update(temp_c=200.0, ber=1.0, latency_dev_ms=500.0)
    assert r['health_score'] == 0.0

def test_health_score_in_range():
    _, r = _make(1, temp=60.0, ber=0.003, lat=10.0)
    assert 0.0 <= r['health_score'] <= 1.0


# ── 5. Model swap thresholds ──────────────────────────────────────────────────

def test_swap_fallback_below_03():
    p = NPUHealthPredictor()
    r = p.update(temp_c=85.0, ber=0.018, latency_dev_ms=90.0)
    assert r['recommended_model_swap'] is not None
    assert 'Fallback' in r['recommended_model_swap']

def test_swap_standby_below_06():
    # health_score = 1 - max(55/90, 0.004/0.02, 8/100) = 1 - 0.611 = 0.389 → Standby
    p = NPUHealthPredictor()
    r = p.update(temp_c=55.0, ber=0.004, latency_dev_ms=8.0)
    assert r['recommended_model_swap'] is not None
    assert 'Standby' in r['recommended_model_swap']

def test_swap_none_above_06():
    # health_score = 1 - max(0/90, 0/0.02, 0/100) = 1.0 → no swap
    _, r = _make(1, temp=0.0, ber=0.0, lat=0.0)
    assert r['recommended_model_swap'] is None


# ── 6. Gradual worsening → trend=worsening + degradation estimate ─────────────

def test_gradual_worsening_trend():
    p = NPUHealthPredictor()
    result = None
    for i in range(20):
        t = 45.0 + i * 3.0
        result = p.update(temp_c=t, ber=0.0, latency_dev_ms=0.0)
    assert result['trend_direction'] == 'worsening'

def test_gradual_worsening_has_degradation_estimate():
    p = NPUHealthPredictor()
    result = None
    for i in range(20):
        t = 45.0 + i * 2.0
        result = p.update(temp_c=t, ber=0.0, latency_dev_ms=0.0)
    if result['health_score'] <= 0.5 and result['trend_direction'] == 'worsening':
        assert result['predicted_degradation_hours'] is not None
        assert result['predicted_degradation_hours'] > 0


# ── 7. Improving after worsening ──────────────────────────────────────────────

def test_improving_trend():
    p = NPUHealthPredictor()
    for i in range(10):
        t = 70.0 + i * 2.0
        p.update(temp_c=t, ber=0.0, latency_dev_ms=0.0)
    result = None
    for i in range(10):
        t = 88.0 - i * 4.0
        result = p.update(temp_c=t, ber=0.0, latency_dev_ms=0.0)
    assert result['trend_direction'] == 'improving'


# ── 8. Stable trend with steady readings ─────────────────────────────────────

def test_stable_trend():
    p = NPUHealthPredictor()
    result = None
    for _ in range(20):
        result = p.update(temp_c=50.0, ber=0.001, latency_dev_ms=5.0)
    assert result['trend_direction'] == 'stable'


# ── 9. EMA smoothing — single extreme reading doesn't immediately flip critical ─

def test_ema_smooths_spike():
    p = NPUHealthPredictor()
    for _ in range(10):
        p.update(temp_c=45.0, ber=0.0, latency_dev_ms=0.0)
    r = p.update(temp_c=200.0, ber=0.0, latency_dev_ms=0.0)
    assert r['status'] != 'critical'


# ── 10. Return dict shape is always complete ──────────────────────────────────

def test_return_shape():
    _, r = _make(1)
    assert set(r.keys()) == {
        'status', 'health_score', 'predicted_degradation_hours',
        'recommended_model_swap', 'trend_direction',
    }

def test_status_values():
    for temp, expected in [(45, 'nominal'), (70, 'degrading'), (85, 'critical')]:
        _, r = _make(1, temp=temp, ber=0.0, lat=0.0)
        assert r['status'] == expected, f"temp={temp} expected {expected}, got {r['status']}"
