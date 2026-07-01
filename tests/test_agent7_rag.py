"""
Tests for Agent 7 local RAG.
These tests run fully offline — no VPN or AIC100 needed.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from backend.agents.agent7_rag import Agent7LocalRAG, CONFIDENCE_THRESHOLD


class TestAgent7LocalRAG:
    def setup_method(self):
        self.rag = Agent7LocalRAG()

    def test_engine_temp_resolves_locally(self):
        chunks, conf, latency = self.rag.query("engine overheating temperature warning")
        assert len(chunks) > 0
        assert latency < 2000   # should be <2s even on cold start with model download

    def test_oil_pressure_resolves_locally(self):
        chunks, conf, latency = self.rag.query("low oil pressure warning light")
        assert len(chunks) > 0
        # Answer should mention stopping the engine
        text = " ".join(chunks).lower()
        assert "stop" in text or "engine" in text

    def test_battery_warning_resolves_locally(self):
        chunks, conf, latency = self.rag.query("battery warning charging fault")
        assert len(chunks) > 0

    def test_confidence_is_float_in_range(self):
        _, conf, _ = self.rag.query("check engine light")
        assert 0.0 <= conf <= 1.0

    def test_latency_under_2000ms(self):
        """After warmup, queries should be fast (embedding already loaded)."""
        # Warmup
        self.rag.query("oil")
        # Timed query
        import time
        t0 = time.perf_counter()
        self.rag.query("brake warning light")
        latency = (time.perf_counter() - t0) * 1000
        assert latency < 500, f"Expected <500ms, got {latency:.0f}ms"

    def test_unknown_query_low_confidence(self):
        _, conf, _ = self.rag.query("xyzzy frobnicate quux")
        # Should have low confidence for nonsense
        assert conf < 0.85   # not expecting >0.85 for nonsense

    def test_cache_response(self):
        import backend.agents.agent7_rag as rag_module
        initial_count = len(rag_module.CORPUS)
        self.rag.add_cached_response(
            "what is TSB 44712",
            "TSB 44712: faulty O2 sensor. Stop if flashing. 14,203 vehicles affected."
        )
        # CORPUS is always updated (both embedding and keyword fallback modes)
        assert len(rag_module.CORPUS) == initial_count + 1

    def test_cached_response_retrievable(self):
        self.rag.add_cached_response(
            "TSB recall notice oxygen sensor",
            "TSB 44712: faulty O2 sensor, stop if light flashing."
        )
        chunks, conf, _ = self.rag.query("oxygen sensor TSB recall")
        text = " ".join(chunks).lower()
        assert "tsb" in text or "oxygen" in text or "sensor" in text

    def test_top_k_respected(self):
        chunks, _, _ = self.rag.query("warning light", top_k=2)
        assert len(chunks) <= 2

    def test_fatigue_safety_advice(self):
        chunks, conf, _ = self.rag.query("I am feeling sleepy should I stop")
        text = " ".join(chunks).lower()
        assert "rest" in text or "stop" in text or "break" in text or "pull" in text
