"""
Tests for backend/fleet/fl_aggregator.py — Track 16: Federated Learning Closed Loop.
No network calls. Bus is mocked.
"""
import sys, os, json, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from unittest.mock import MagicMock, patch
from backend.fleet.fl_aggregator import FLAggregator


def _make_agg(n_vehicles=5):
    mock_bus = MagicMock()
    return FLAggregator(bus=mock_bus, n_vehicles=n_vehicles), mock_bus


# ---------------------------------------------------------------------------
# 1. Initial state
# ---------------------------------------------------------------------------

def test_initial_threshold():
    agg, _ = _make_agg()
    status = agg.get_status()
    assert status["current_threshold"] == 0.70


def test_initial_no_update():
    agg, _ = _make_agg()
    status = agg.get_status()
    assert status["last_update"] is None


def test_initial_update_count_zero():
    agg, _ = _make_agg()
    assert agg.get_status()["update_count"] == 0


def test_initial_vehicle_count_zero():
    agg, _ = _make_agg()
    assert agg.get_status()["vehicle_count"] == 0


# ---------------------------------------------------------------------------
# 2. collect_uncertainty
# ---------------------------------------------------------------------------

def test_collect_adds_vehicle():
    agg, _ = _make_agg()
    agg.collect_uncertainty("CAB-001", 0.5, 12.0)
    assert agg.get_status()["vehicle_count"] == 1


def test_collect_overwrites_same_vehicle():
    agg, _ = _make_agg()
    agg.collect_uncertainty("CAB-001", 0.5, 12.0)
    agg.collect_uncertainty("CAB-001", 0.8, 7.0)
    status = agg.get_status()
    assert status["vehicle_count"] == 1
    assert status["vehicles"]["CAB-001"]["drowsiness_score"] == 0.8


def test_collect_multiple_vehicles():
    agg, _ = _make_agg()
    for i in range(5):
        agg.collect_uncertainty(f"CAB-00{i+1}", 0.3, 14.0)
    assert agg.get_status()["vehicle_count"] == 5


# ---------------------------------------------------------------------------
# 3. aggregate — drowsiness pattern
# ---------------------------------------------------------------------------

def test_aggregate_returns_none_when_no_pattern():
    agg, _ = _make_agg()
    agg.collect_uncertainty("CAB-001", 0.20, 15.0)
    agg.collect_uncertainty("CAB-002", 0.25, 14.0)
    agg.collect_uncertainty("CAB-003", 0.15, 16.0)
    result = agg.aggregate()
    assert result is None


def test_aggregate_triggers_on_fleet_drowsiness():
    agg, _ = _make_agg()
    # 4 out of 5 vehicles (80%) have drowsiness > 0.45 → triggers at >60%
    agg.collect_uncertainty("CAB-001", 0.55, 12.0)
    agg.collect_uncertainty("CAB-002", 0.60, 11.0)
    agg.collect_uncertainty("CAB-003", 0.65, 10.0)
    agg.collect_uncertainty("CAB-004", 0.70, 9.0)
    agg.collect_uncertainty("CAB-005", 0.20, 15.0)
    result = agg.aggregate()
    assert result is not None
    assert result["reason"] == "fleet-wide elevated drowsiness"
    assert result["new_threshold"] == 0.60


def test_aggregate_drowsiness_exactly_at_threshold():
    agg, _ = _make_agg()
    # Exactly 3 out of 5 = 60% — NOT > 60%, so no trigger
    agg.collect_uncertainty("CAB-001", 0.50, 12.0)
    agg.collect_uncertainty("CAB-002", 0.50, 12.0)
    agg.collect_uncertainty("CAB-003", 0.50, 12.0)
    agg.collect_uncertainty("CAB-004", 0.20, 15.0)
    agg.collect_uncertainty("CAB-005", 0.20, 15.0)
    result = agg.aggregate()
    assert result is None


def test_aggregate_drowsiness_just_above_threshold():
    agg, _ = _make_agg()
    # 4 out of 5 = 80% — above 60%
    for i in range(4):
        agg.collect_uncertainty(f"CAB-00{i+1}", 0.55, 12.0)
    agg.collect_uncertainty("CAB-005", 0.10, 18.0)
    result = agg.aggregate()
    assert result is not None
    assert result["new_threshold"] == 0.60


# ---------------------------------------------------------------------------
# 4. aggregate — blink frequency pattern
# ---------------------------------------------------------------------------

def test_aggregate_triggers_on_low_blink():
    agg, _ = _make_agg()
    # 3 out of 5 = 60% > 40% threshold with low blink and safe drowsiness
    agg.collect_uncertainty("CAB-001", 0.20, 7.0)
    agg.collect_uncertainty("CAB-002", 0.20, 8.0)
    agg.collect_uncertainty("CAB-003", 0.20, 9.0)
    agg.collect_uncertainty("CAB-004", 0.20, 14.0)
    agg.collect_uncertainty("CAB-005", 0.20, 15.0)
    result = agg.aggregate()
    assert result is not None
    assert result["reason"] == "fleet-wide low blink frequency"
    assert result["new_threshold"] == 0.55


def test_aggregate_blink_result_has_vehicle_count():
    agg, _ = _make_agg()
    for i in range(3):
        agg.collect_uncertainty(f"CAB-00{i+1}", 0.20, 7.0)
    for i in range(3, 5):
        agg.collect_uncertainty(f"CAB-00{i+1}", 0.20, 15.0)
    result = agg.aggregate()
    if result:
        assert "vehicle_count" in result
        assert result["vehicle_count"] == 5


def test_aggregate_no_data_returns_none():
    agg, _ = _make_agg()
    result = agg.aggregate()
    assert result is None


# ---------------------------------------------------------------------------
# 5. apply_update
# ---------------------------------------------------------------------------

def test_apply_update_changes_threshold():
    agg, _ = _make_agg()
    agg.apply_update({"new_threshold": 0.60, "reason": "test"})
    assert agg._current_threshold == 0.60


def test_apply_update_increments_count():
    agg, _ = _make_agg()
    agg.apply_update({"new_threshold": 0.60, "reason": "test"})
    assert agg._update_count == 1


def test_apply_update_publishes_to_bus():
    agg, mock_bus = _make_agg()
    update = {"new_threshold": 0.60, "reason": "test", "vehicle_count": 5}
    agg.apply_update(update)
    mock_bus.publish.assert_called_once_with("FL_THRESHOLD_UPDATE", update)


def test_apply_update_writes_audit_log(tmp_path):
    mock_bus = MagicMock()
    agg = FLAggregator(bus=mock_bus, n_vehicles=5)
    update = {"new_threshold": 0.55, "reason": "test", "vehicle_count": 3}
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    log_path = log_dir / "fl_audit.log"
    with patch.object(agg, "_write_audit_log") as mock_log:
        agg.apply_update(update)
        mock_log.assert_called_once_with(update)


def test_apply_update_no_bus_does_not_crash():
    agg = FLAggregator(bus=None, n_vehicles=5)
    agg.apply_update({"new_threshold": 0.60, "reason": "test"})
    assert agg._current_threshold == 0.60


# ---------------------------------------------------------------------------
# 6. get_status
# ---------------------------------------------------------------------------

def test_get_status_returns_dict():
    agg, _ = _make_agg()
    status = agg.get_status()
    assert isinstance(status, dict)


def test_get_status_required_keys():
    agg, _ = _make_agg()
    status = agg.get_status()
    required = {"current_threshold", "last_update", "update_count", "vehicle_count", "vehicles"}
    assert required.issubset(status.keys())


def test_get_status_after_update():
    agg, _ = _make_agg()
    update = {"new_threshold": 0.60, "reason": "fleet-wide elevated drowsiness", "vehicle_count": 5}
    agg.apply_update(update)
    status = agg.get_status()
    assert status["current_threshold"] == 0.60
    assert status["last_update"] == update
    assert status["update_count"] == 1


# ---------------------------------------------------------------------------
# 7. Full end-to-end: collect -> aggregate -> apply
# ---------------------------------------------------------------------------

def test_full_pipeline():
    agg, mock_bus = _make_agg()
    old_threshold = agg._current_threshold

    for i in range(5):
        agg.collect_uncertainty(f"CAB-00{i+1}", 0.60 + i * 0.02, 8.0)

    update = agg.aggregate()
    assert update is not None

    agg.apply_update(update)

    assert agg._current_threshold != old_threshold
    assert agg._update_count == 1
    mock_bus.publish.assert_called_once()
