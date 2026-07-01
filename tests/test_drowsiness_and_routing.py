"""Tests for drowsiness metric computation and query routing."""
import sys, os, math
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from backend.orchestrator.query_router import extract_features, route_query


# ---------------------------------------------------------------------------
# EAR / perclos / drowsiness (Python re-implementation matching JS logic)
# ---------------------------------------------------------------------------
def _dist(p1, p2):
    return math.sqrt((p1[0]-p2[0])**2 + (p1[1]-p2[1])**2)

def compute_ear(landmarks, indices):
    p = lambda i: landmarks[indices[i]]
    return (_dist(p(1), p(5)) + _dist(p(2), p(4))) / (2 * _dist(p(0), p(3)))

def compute_perclos(ear_history, threshold=0.20):
    if not ear_history:
        return 0.0
    closed = sum(1 for e in ear_history if e < threshold)
    return closed / len(ear_history)

def compute_drowsiness(ear, perclos, blink_freq):
    ear_norm   = max(0, min(1, 1 - ear / 0.35))
    perc_norm  = min(1, perclos / 0.15)
    blink_norm = 1 if blink_freq < 5 else (0 if blink_freq > 20 else 1 - (blink_freq - 5) / 15)
    return 0.4 * ear_norm + 0.4 * perc_norm + 0.2 * blink_norm


# ---------------------------------------------------------------------------
# EAR tests
# ---------------------------------------------------------------------------
class TestEAR:
    def _open_eye(self):
        # Synthetic open eye: height = 0.24, width = 0.6 → EAR ≈ 0.40
        return [(0,0), (0.1,0.12), (0.3,0.12), (0.6,0), (0.3,-0.12), (0.1,-0.12)]

    def _closed_eye(self):
        # Closed: height = 0.01, width = 0.6 → EAR ≈ 0.03
        return [(0,0), (0.1,0.005), (0.3,0.005), (0.6,0), (0.3,-0.005), (0.1,-0.005)]

    def test_open_ear_in_range(self):
        ear = compute_ear(self._open_eye(), list(range(6)))
        assert 0.30 < ear < 0.55, f"Expected 0.30-0.55, got {ear:.3f}"

    def test_closed_ear_low(self):
        ear = compute_ear(self._closed_eye(), list(range(6)))
        assert ear < 0.10, f"Expected <0.10 for closed eye, got {ear:.3f}"

    def test_ear_threshold_boundary(self):
        ear_open   = compute_ear(self._open_eye(),   list(range(6)))
        ear_closed = compute_ear(self._closed_eye(), list(range(6)))
        assert ear_open   > 0.20, "Open eye should be above EAR threshold"
        assert ear_closed < 0.20, "Closed eye should be below EAR threshold"


class TestPerclos:
    def test_all_open_gives_zero(self):
        history = [0.35] * 1800
        assert compute_perclos(history) == 0.0

    def test_all_closed_gives_one(self):
        history = [0.05] * 1800
        assert compute_perclos(history) == 1.0

    def test_partial(self):
        history = [0.05] * 900 + [0.35] * 900
        assert abs(compute_perclos(history) - 0.5) < 0.01

    def test_empty(self):
        assert compute_perclos([]) == 0.0


class TestDrowsinessScore:
    def test_alert_driver_scores_low(self):
        score = compute_drowsiness(ear=0.35, perclos=0.01, blink_freq=15)
        assert score < 0.3, f"Alert driver should score < 0.3, got {score:.3f}"

    def test_drowsy_driver_scores_high(self):
        score = compute_drowsiness(ear=0.10, perclos=0.20, blink_freq=3)
        assert score > 0.7, f"Drowsy driver should score > 0.7, got {score:.3f}"

    def test_threshold_triggers_alert(self):
        score = compute_drowsiness(ear=0.10, perclos=0.20, blink_freq=3)
        assert score > 0.7   # ZeroClaw fires alert at > 0.7

    def test_score_in_range(self):
        for ear in [0.05, 0.20, 0.35]:
            for perclos in [0.0, 0.1, 0.5]:
                s = compute_drowsiness(ear, perclos, 12)
                assert 0.0 <= s <= 1.0


# ---------------------------------------------------------------------------
# Query routing tests
# ---------------------------------------------------------------------------
class TestQueryRouter:
    def test_simple_routes_agent4(self):
        f = extract_features("play jazz music")
        assert route_query(f, {}) == "AGENT4"

    def test_volume_routes_agent4(self):
        f = extract_features("turn up the volume")
        assert route_query(f, {}) == "AGENT4"

    def test_complex_routes_agent6(self):
        f = extract_features("should I stop given how I feel after driving for three hours")
        assert route_query(f, {}) == "AGENT6"

    def test_external_data_routes_agent6(self):
        f = extract_features("what is the weather like")
        assert route_query(f, {}) == "AGENT6"

    def test_long_query_routes_agent6(self):
        long_q = " ".join(["word"] * 16)   # 16 tokens > threshold 15
        f = extract_features(long_q)
        assert route_query(f, {}) == "AGENT6"

    def test_agent7_escalate_flag_routes_agent6(self):
        f = extract_features("check engine light")
        f["agent7_escalate"] = True
        assert route_query(f, {}) == "AGENT6"

    def test_token_count_correct(self):
        f = extract_features("hello world test")
        assert f["token_count"] == 3

    def test_temporal_detected(self):
        f = extract_features("what happened last week on the drive")
        assert f["has_temporal_ref"] is True
