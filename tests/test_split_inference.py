"""
Tests for backend/orchestrator/split_inference.py — Track 15: Dynamic Split Inference PoC.
All network calls are mocked (no Ollama, no QGenie).
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from unittest.mock import patch, MagicMock
from backend.orchestrator.split_inference import SplitInferenceOrchestrator, _VIDEO_FRAME_BYTES_ACTUAL


def _make_orch(**env_overrides):
    with patch.dict(os.environ, env_overrides):
        return SplitInferenceOrchestrator()


# ---------------------------------------------------------------------------
# 1. Constructor reads env vars
# ---------------------------------------------------------------------------

def test_default_edge_tokens():
    orch = SplitInferenceOrchestrator()
    assert orch._edge_tokens == 60


def test_custom_edge_tokens():
    with patch.dict(os.environ, {"SPLIT_EDGE_TOKENS": "30"}):
        orch = SplitInferenceOrchestrator()
    assert orch._edge_tokens == 30


def test_split_enabled_default():
    orch = SplitInferenceOrchestrator()
    assert orch._enabled is True


def test_split_disabled_via_env():
    with patch.dict(os.environ, {"SPLIT_ENABLED": "false"}):
        orch = SplitInferenceOrchestrator()
    assert orch._enabled is False


# ---------------------------------------------------------------------------
# 2. Edge fallback when Ollama is unreachable
# ---------------------------------------------------------------------------

def test_edge_fallback_returns_string():
    orch = SplitInferenceOrchestrator()
    with patch("requests.post", side_effect=ConnectionError("no ollama")):
        prefix = orch._call_edge("What is the speed limit on ORR?", "")
    assert isinstance(prefix, str)
    assert len(prefix) > 0


def test_edge_fallback_content():
    orch = SplitInferenceOrchestrator()
    with patch("requests.post", side_effect=ConnectionError("no ollama")):
        prefix = orch._call_edge("What is the speed limit on ORR?", "")
    assert "speed" in prefix.lower() or "what" in prefix.lower() or "regarding" in prefix.lower()


# ---------------------------------------------------------------------------
# 3. Cloud fallback when QGenie is disabled
# ---------------------------------------------------------------------------

def test_cloud_fallback_without_qgenie():
    orch = SplitInferenceOrchestrator()
    with patch.dict(os.environ, {"QGENIE_ENABLED": "false", "QGENIE_API_KEY": ""}):
        result = orch._call_cloud("some query", "some prefix", "")
    assert isinstance(result, str)
    assert len(result) > 0


# ---------------------------------------------------------------------------
# 4. run() with mocked edge + cloud
# ---------------------------------------------------------------------------

def _mock_ollama_response(prefix_text: str):
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "message": {"content": prefix_text},
        "done": True,
    }
    return mock_resp


def test_run_returns_required_keys():
    orch = SplitInferenceOrchestrator()
    with patch("requests.post", return_value=_mock_ollama_response("Speed limit is 100 km/h on ORR")):
        with patch.dict(os.environ, {"QGENIE_ENABLED": "false", "QGENIE_API_KEY": ""}):
            result = orch.run("What is the speed limit on ORR?", context="")
    required = {"edge_prefix", "cloud_continuation", "total_tokens", "edge_tokens",
                "cloud_tokens", "latency_ms", "bytes_transferred"}
    assert required.issubset(set(result.keys()))


def test_run_edge_prefix_in_result():
    orch = SplitInferenceOrchestrator()
    expected_prefix = "Speed limit is 100 km/h on the ORR"
    with patch("requests.post", return_value=_mock_ollama_response(expected_prefix)):
        with patch.dict(os.environ, {"QGENIE_ENABLED": "false", "QGENIE_API_KEY": ""}):
            result = orch.run("What is the speed limit?", context="")
    assert result["edge_prefix"] == expected_prefix


def test_run_bytes_transferred_matches_prefix():
    orch = SplitInferenceOrchestrator()
    prefix = "Edge response text here"
    with patch("requests.post", return_value=_mock_ollama_response(prefix)):
        with patch.dict(os.environ, {"QGENIE_ENABLED": "false", "QGENIE_API_KEY": ""}):
            result = orch.run("test query", context="")
    assert result["bytes_transferred"] == len(prefix.encode("utf-8"))


def test_run_token_counts_positive():
    orch = SplitInferenceOrchestrator()
    with patch("requests.post", return_value=_mock_ollama_response("some response text")):
        with patch.dict(os.environ, {"QGENIE_ENABLED": "false", "QGENIE_API_KEY": ""}):
            result = orch.run("query", context="")
    assert result["edge_tokens"] >= 1
    assert result["cloud_tokens"] >= 1
    assert result["total_tokens"] == result["edge_tokens"] + result["cloud_tokens"]


def test_run_latency_ms_is_positive():
    orch = SplitInferenceOrchestrator()
    with patch("requests.post", return_value=_mock_ollama_response("text")):
        with patch.dict(os.environ, {"QGENIE_ENABLED": "false", "QGENIE_API_KEY": ""}):
            result = orch.run("query", context="")
    assert result["latency_ms"] >= 0


# ---------------------------------------------------------------------------
# 5. measure_compression_ratio
# ---------------------------------------------------------------------------

def test_compression_ratio_keys():
    orch = SplitInferenceOrchestrator()
    r = orch.measure_compression_ratio(60)
    assert {"prefix_bytes", "video_frame_bytes", "compression_ratio", "savings_pct"}.issubset(r.keys())


def test_video_frame_bytes_constant():
    orch = SplitInferenceOrchestrator()
    r = orch.measure_compression_ratio(60)
    assert r["video_frame_bytes"] == _VIDEO_FRAME_BYTES_ACTUAL


def test_compression_ratio_positive():
    orch = SplitInferenceOrchestrator()
    r = orch.measure_compression_ratio(60)
    assert r["compression_ratio"] > 1.0


def test_savings_pct_range():
    orch = SplitInferenceOrchestrator()
    r = orch.measure_compression_ratio(60)
    assert 0.0 <= r["savings_pct"] <= 100.0


def test_larger_tokens_lower_savings():
    orch = SplitInferenceOrchestrator()
    r_small = orch.measure_compression_ratio(30)
    r_large = orch.measure_compression_ratio(1000)
    assert r_small["savings_pct"] >= r_large["savings_pct"]
