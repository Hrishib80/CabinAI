"""Tests for SessionBuffer compression and size constraints."""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from backend.agents.session_buffer import SessionBuffer, MAX_FRAMES


def make_landmarks(n=468, val=0.5):
    return [{"x": val, "y": val, "z": 0.0}] * n

def make_metrics(ds=0.1):
    return {"ear": 0.32, "perclos": 0.02, "blink_freq": 15, "head_pose_drift": 0.01,
            "drowsiness_score": ds}


class TestSessionBuffer:
    def test_initial_empty(self):
        buf = SessionBuffer()
        assert len(buf.frames) == 0

    def test_sample_adds_frame(self):
        buf = SessionBuffer()
        buf._last_sample_ts = 0   # force sample on first call
        added = buf.maybe_sample(make_landmarks(), make_metrics())
        assert added is True
        assert len(buf.frames) == 1

    def test_no_double_sample_within_1s(self):
        buf = SessionBuffer()
        buf._last_sample_ts = 0
        buf.maybe_sample(make_landmarks(), make_metrics())
        added = buf.maybe_sample(make_landmarks(), make_metrics())
        assert added is False, "Should not sample twice within 1 second"

    def test_buffer_capped_at_max_frames(self):
        buf = SessionBuffer()
        for i in range(MAX_FRAMES + 50):
            buf._last_sample_ts = 0
            buf.maybe_sample(make_landmarks(), make_metrics())
        assert len(buf.frames) == MAX_FRAMES

    def test_payload_within_32kb(self):
        buf = SessionBuffer()
        for _ in range(MAX_FRAMES):
            buf._last_sample_ts = 0
            buf.maybe_sample(make_landmarks(), make_metrics())
        payload = buf.to_sync_payload()
        size = len(json.dumps(payload).encode())
        assert size < 32 * 1024, f"Payload {size} bytes exceeds 32 KB AIC100 limit"

    def test_payload_has_required_keys(self):
        buf = SessionBuffer()
        buf._last_sample_ts = 0
        buf.maybe_sample(make_landmarks(), make_metrics())
        payload = buf.to_sync_payload()
        for key in ("frame_count", "attention_scores", "ear_series",
                    "perclos_series", "blink_freq_series", "drowsiness_events",
                    "npu_latency_deviation_ms", "thermal_reading_c"):
            assert key in payload, f"Missing key: {key}"

    def test_drowsiness_event_counter(self):
        buf = SessionBuffer()
        for i in range(5):
            buf._last_sample_ts = 0
            buf.maybe_sample(make_landmarks(), make_metrics(ds=0.9))  # above 0.7
        assert buf.drowsiness_event_count == 5

    def test_reset_clears_everything(self):
        buf = SessionBuffer()
        buf._last_sample_ts = 0
        buf.maybe_sample(make_landmarks(), make_metrics())
        buf.reset()
        assert len(buf.frames) == 0
        assert buf.drowsiness_event_count == 0

    def test_ingest_from_frontend(self):
        buf = SessionBuffer()
        buf.ingest_from_frontend({"ear": 0.3, "perc": 0.01, "kp": [0]*45})
        assert len(buf.frames) == 1

    def test_compressed_frame_structure(self):
        buf = SessionBuffer()
        buf._last_sample_ts = 0
        buf.maybe_sample(make_landmarks(), make_metrics())
        frame = buf.frames[0]
        assert "kp" in frame                  # compressed keypoints
        assert len(frame["kp"]) == 15 * 3     # 15 landmarks × 3 coords
        for val in frame["kp"]:
            assert -127 <= val <= 127          # int8 range

    def test_npu_health_update(self):
        buf = SessionBuffer()
        buf.update_npu_health(latency_dev=2.3, thermal=71.2, ber=0.0008)
        assert buf.npu_latency_deviation_ms == 2.3
        assert buf.thermal_reading_c == 71.2
