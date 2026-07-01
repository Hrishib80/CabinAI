"""
Session buffer: accumulates 1-FPS compressed keypoint frames from Agent 1.
Serialises to <32 KB JSON for the Agent 5 AIC100 sync payload.
"""
import json, time
import numpy as np

# 15 key landmark indices out of MediaPipe FaceMesh 468-pt:
# left/right eye corners (4), nose tip (1), lip corners (2),
# eyebrow anchors (4), forehead (2), chin (2)
KEY_LANDMARKS = [33, 133, 362, 263, 1, 61, 291, 70, 300, 107, 336, 10, 152, 234, 454]
MAX_FRAMES = 300  # 5 min @ 1 FPS


class SessionBuffer:
    def __init__(self):
        self.frames: list[dict] = []
        self._last_sample_ts = 0.0
        # NPU health fields (updated from monitoring thread)
        self.npu_latency_deviation_ms: float = 0.0
        self.thermal_reading_c: float = 45.0
        self.memory_error_rate: float = 0.0
        self.drowsiness_event_count: int = 0

    # ------------------------------------------------------------------
    # Ingest (called from Agent 1 at 30 FPS; internally downsamples to 1 FPS)
    # ------------------------------------------------------------------
    def maybe_sample(self, landmarks: list[dict], metrics: dict) -> bool:
        """
        landmarks: list of 468 dicts with keys 'x','y','z' (normalised 0-1).
        metrics:   dict with ear, perclos, blink_freq, head_pose_drift, drowsiness_score.
        Returns True if a frame was actually stored.
        """
        now = time.time()
        if now - self._last_sample_ts < 1.0:
            return False
        self._last_sample_ts = now

        # Compress: extract 15 key landmarks, quantise x/y/z to int8
        compressed = []
        for idx in KEY_LANDMARKS:
            lm = landmarks[idx] if idx < len(landmarks) else {"x": 0, "y": 0, "z": 0}
            compressed.extend([
                max(-127, min(127, int(lm.get("x", 0) * 127))),
                max(-127, min(127, int(lm.get("y", 0) * 127))),
                max(-127, min(127, int(lm.get("z", 0) * 127))),
            ])

        self.frames.append({
            "kp": compressed,           # 45 int8 values
            "ear":   round(metrics.get("ear", 0.3), 4),
            "perc":  round(metrics.get("perclos", 0.0), 4),
            "blink": round(metrics.get("blink_freq", 15.0), 2),
            "hpd":   round(metrics.get("head_pose_drift", 0.0), 4),
            "ds":    round(metrics.get("drowsiness_score", 0.0), 4),
        })

        if len(self.frames) > MAX_FRAMES:
            self.frames.pop(0)

        if metrics.get("drowsiness_score", 0) > 0.7:
            self.drowsiness_event_count += 1

        return True

    # ------------------------------------------------------------------
    # Direct ingest from frontend JSON POST
    # ------------------------------------------------------------------
    def ingest_from_frontend(self, frame_data: dict):
        self.frames.append(frame_data)
        if len(self.frames) > MAX_FRAMES:
            self.frames.pop(0)

    def update_npu_health(self, latency_dev: float, thermal: float, ber: float):
        self.npu_latency_deviation_ms = latency_dev
        self.thermal_reading_c = thermal
        self.memory_error_rate = ber

    # ------------------------------------------------------------------
    # Serialise — must stay < 32 KB
    # ------------------------------------------------------------------
    def to_sync_payload(self) -> dict:
        n = len(self.frames)
        return {
            "frame_count":              n,
            "attention_scores":         [f.get("ds", 0.0)   for f in self.frames],
            "ear_series":               [f.get("ear", 0.3)  for f in self.frames],
            "perclos_series":           [f.get("perc", 0.0) for f in self.frames],
            "blink_freq_series":        [f.get("blink", 15) for f in self.frames],
            "head_pose_drift_series":   [f.get("hpd", 0.0)  for f in self.frames],
            "drowsiness_events":        self.drowsiness_event_count,
            "npu_latency_deviation_ms": self.npu_latency_deviation_ms,
            "thermal_reading_c":        self.thermal_reading_c,
            "memory_error_rate":        self.memory_error_rate,
        }

    def payload_size_bytes(self) -> int:
        return len(json.dumps(self.to_sync_payload()).encode())

    def reset(self):
        self.frames.clear()
        self.drowsiness_event_count = 0
