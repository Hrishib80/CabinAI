"""
ZeroClaw shared state bus — Python backend mirror.
Keeps canonical agent state that endpoints can read/write.
Thread-safe; frontend polls /api/state or subscribes to SSE /api/events.
"""
import threading, time
from dataclasses import dataclass, field, asdict
from typing import Any, Callable


@dataclass
class BusState:
    # Agent 1 outputs
    attention_score:    float = 1.0
    drowsiness_score:   float = 0.0
    drowsiness_flag:    bool  = False
    ear:                float = 0.30
    perclos:            float = 0.0
    blink_freq:         float = 15.0
    # Agent 5 outputs
    fatigue_forecast:   float = 0.0
    forecast_confidence:float = 0.0
    # Enriched context (from Agent 5)
    recommended_rest:   str   = ""
    route_complexity:   str   = "unknown"
    driver_fatigue_state: float = 0.0
    fatigue_forecast_t15: float = 0.0
    # Agent 7 state
    agent7_escalate:    bool  = False
    # NPU health
    npu_status:         str   = "nominal"
    npu_temp_c:         float = 45.0
    npu_ber:            float = 0.0
    npu_latency_dev_ms: float = 0.0
    npu_prediction:     dict  = field(default_factory=dict)
    # Network
    network_state:      str   = "online"
    battery_level:      float = 1.0
    # Session
    session_events:     list  = field(default_factory=list)
    last_sync_ts:       float = 0.0
    next_sync_in_s:     float = 300.0
    # Proactive alert
    proactive_alert_msg:  str = ""
    proactive_alert_urgency: str = ""
    # Driving simulator state (sim ↔ app linkage)
    game_speed:        float = 0.0
    game_rpm:          float = 800.0
    game_location:     str   = "Gachibowli"
    game_segment_type: str   = "parking"
    game_engine_temp:  float = 0.35
    game_fuel:         float = 1.0
    game_oil_pressure: float = 1.0
    game_battery:      float = 1.0
    game_distance_km:  float = 0.0
    game_paused:       bool  = True
    # FL aggregator state (Track 16)
    fl_threshold:      float = 0.70
    fl_last_update:    dict  = field(default_factory=dict)


class ZeroClawBus:
    def __init__(self):
        self._state  = BusState()
        self._lock   = threading.RLock()
        self._subs:  dict[str, list[Callable]] = {}
        self._safety_active = False
        self._sse_clients: list = []     # (queue,) tuples for SSE

    # ------------------------------------------------------------------
    def publish(self, event: str, data: Any):
        _safety_passthrough = (
            "SAFETY_ALERT", "PERCEPTION_UPDATE",
            "GAME_JUMP_REQUEST", "GAME_SPEED_REQUEST",
            "GAME_WEATHER_REQUEST", "GAME_TOGGLE_REQUEST",
        )
        if self._safety_active and event not in _safety_passthrough:
            return
        with self._lock:
            self._apply(event, data)
            serialised = {"event": event, "data": data, "ts": time.time()}
        for handler in self._subs.get(event, []):
            try:
                handler(data)
            except Exception:
                pass
        self._push_sse(serialised)

    def subscribe(self, event: str, handler: Callable):
        self._subs.setdefault(event, []).append(handler)

    def get_state(self) -> dict:
        with self._lock:
            return asdict(self._state)

    def add_sse_client(self, q):
        self._sse_clients.append(q)

    def remove_sse_client(self, q):
        self._sse_clients = [c for c in self._sse_clients if c is not q]

    # ------------------------------------------------------------------
    def _push_sse(self, msg: dict):
        import json
        dead = []
        for q in self._sse_clients:
            try:
                q.put_nowait(json.dumps(msg))
            except Exception:
                dead.append(q)
        for d in dead:
            self.remove_sse_client(d)

    def _apply(self, event: str, data: Any):
        s = self._state
        if event == "PERCEPTION_UPDATE" and isinstance(data, dict):
            s.attention_score  = data.get("attention_score", s.attention_score)
            s.drowsiness_score = data.get("drowsiness_score", s.drowsiness_score)
            s.ear              = data.get("ear", s.ear)
            s.perclos          = data.get("perclos", s.perclos)
            s.blink_freq       = data.get("blink_freq", s.blink_freq)
            if s.drowsiness_score > 0.7 and not self._safety_active:
                self._activate_safety()
                s.drowsiness_flag = True
            elif s.drowsiness_score < 0.5:
                self._safety_active = False
                s.drowsiness_flag = False

        elif event == "FATIGUE_FORECAST" and isinstance(data, dict):
            s.fatigue_forecast    = data.get("fatigue_forecast", 0.0)
            s.forecast_confidence = data.get("forecast_confidence", 0.0)
            ctx = data.get("enriched_system_prompt", {})
            s.driver_fatigue_state  = ctx.get("driver_fatigue_state", s.driver_fatigue_state)
            s.fatigue_forecast_t15  = ctx.get("fatigue_forecast_t15", s.fatigue_forecast_t15)
            s.recommended_rest      = ctx.get("recommended_rest", "") or ""
            s.route_complexity      = ctx.get("route_complexity", s.route_complexity)
            alert = data.get("proactive_alert", {})
            s.proactive_alert_msg     = alert.get("msg", "") or ""
            s.proactive_alert_urgency = alert.get("urgency", "") or ""
            hw = data.get("hardware_health", {})
            s.npu_status = hw.get("status", "nominal")
            s.last_sync_ts   = time.time()
            s.next_sync_in_s = 300.0

        elif event == "SYNC_TICK":
            s.next_sync_in_s = max(0, s.next_sync_in_s - 1)

        elif event == "NPU_HEALTH":
            if isinstance(data, dict):
                s.npu_temp_c       = data.get("temp_c", s.npu_temp_c)
                s.npu_ber          = data.get("ber", s.npu_ber)
                s.npu_latency_dev_ms = data.get("latency_dev_ms", s.npu_latency_dev_ms)

        elif event == "NPU_PREDICTION":
            if isinstance(data, dict):
                s.npu_prediction = data

        elif event == "SESSION_EVENT":
            s.session_events.append(data)
            if len(s.session_events) > 50:
                s.session_events = s.session_events[-50:]

        elif event == "FL_THRESHOLD_UPDATE" and isinstance(data, dict):
            s.fl_threshold = data.get("new_threshold", s.fl_threshold)
            s.fl_last_update = data

        elif event == "GAME_STATE" and isinstance(data, dict):
            s.game_speed         = data.get("game_speed", s.game_speed)
            s.game_rpm           = data.get("game_rpm", s.game_rpm)
            s.game_location      = data.get("game_location", s.game_location)
            s.game_segment_type  = data.get("game_segment_type", s.game_segment_type)
            s.game_engine_temp   = data.get("game_engine_temp", s.game_engine_temp)
            s.game_fuel          = data.get("game_fuel", s.game_fuel)
            s.game_oil_pressure  = data.get("game_oil_pressure", s.game_oil_pressure)
            s.game_battery       = data.get("game_battery", s.game_battery)
            s.game_distance_km   = data.get("game_distance_km", s.game_distance_km)
            s.game_paused        = data.get("game_paused", s.game_paused)

    def _activate_safety(self):
        self._safety_active = True
        self._state.drowsiness_flag = True
        self._push_sse({"event": "SAFETY_ALERT",
                        "data": {"msg": "DROWSINESS DETECTED — ALL AGENTS SUSPENDED"},
                        "ts": time.time()})
        t = threading.Timer(30.0, self._try_deactivate_safety)
        t.daemon = True
        t.start()

    def _try_deactivate_safety(self):
        if self._state.drowsiness_score < 0.5:
            self._safety_active = False
            self._state.drowsiness_flag = False


# Singleton instance shared across all Flask request threads
bus = ZeroClawBus()
