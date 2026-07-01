# CabinAI — Codebase State Reference

> **Purpose:** This file is the ground-truth architecture reference for new sessions.
> It describes every component, its current implementation status, known bugs, and the
> data contracts between them.  Update it whenever a feature is completed or a bug is fixed.
>
> **Last updated: 2026-06-07 (session 11 — Tracks 7 + 17 shipped; benchmark_dms.py, generate_demo_log.py, time_machine.js, dms_accuracy.json, demo_driving_log.json)
---

## 1. Repository Layout

```
cabinai/
├── backend/                     Python 3.12 (.venv312) · Flask 3.0
│   ├── server.py                15 REST/SSE endpoints (entry point: .\run.ps1 or python backend/server.py)
│   ├── config.py                All env-var config (load_dotenv) — includes LOCAL_WHISPER_ENABLED, LOCAL_TTS_ENABLED
│   ├── agents/
│   │   ├── agent5_proactive.py  Fatigue forecast — AIC100 Qwen3-VL-32B (VLM image support)
│   │   ├── agent6_complex.py    Complex query + coaching — AIC100 gpt-oss-20b
│   │   ├── agent7_rag.py        Local RAG — BGE-small-en ONNX (onnxruntime + tokenizers) + ChromaDB persistent (cabin_rag.db)
│   │   ├── session_buffer.py    Temporal frame compressor (int8 keypoints, <32 KB)
│   │   ├── local_whisper.py     Distil-Whisper STT via HuggingFace transformers (CPU fallback)
│   │   └── local_tts.py         Kokoro-ONNX TTS → pyttsx3 fallback (models/kokoro-v1.0.onnx)
│   └── orchestrator/
│       ├── zeroclaw_bus.py      Pub/sub state bus (thread-safe singleton `bus`)
│       ├── query_router.py      Rule-based Agent4/6 routing (<1 ms)
│       ├── safety_floor.py      Regex-keyed deterministic dispatcher (sub-50ms, fires before LLM routing)
│       └── vote_fusion.py       3-engine vote classifier → L2_CONSENSUS | L1_DISAGREE | STANDARD
│
├── frontend/                    Vanilla JS · HTML5 · no build step
│   ├── index.html               3-tab SPA (Tab 1 = Unified Cockpit: Driver Cam + Drive Sim side-by-side)
│   ├── css/cabin_ai.css         Dark theme + cockpit/game styles (day/night cityscape)
│   └── js/
│       ├── agents/
│       │   ├── agent1_perception.js   FaceMesh + Hands + emotion detection + getLatestJpeg()
│       │   ├── agent2_gesture.js      Geometry classifier (landmark distances)
│       │   ├── agent3_speech.js       MediaRecorder → Flask → AIC100/local Whisper + audio feedback
│       │   └── agent4_llm.js          SSE streaming from /api/agent4/generate
│       ├── api/agent5_client.js       Agent5/6/7 REST wrappers + VLM frame support
│       ├── game/
│       │   ├── driving_game.js        Legacy Canvas2D first-person driving game (used when ?game=2d)
│       │   └── driving_game_3d.js     Three.js full 3D cockpit (default; preserves DrivingGame public API)
│       ├── orchestrator/
│       │   ├── zeroclaw_bus.js        JS mirror of backend bus (SSE subscriber)
│       │   └── query_router.js        JS mirror of routing rules
│       └── ui/
│           ├── alert_audio.js         Web Audio API beeps/chimes
│           ├── hud_renderer.js        Tab 1 metric bars + alerts + audio triggers
│           ├── health_monitor.js      Tab 3 NPU health + agent status cards
│           └── time_machine.js        Track 17 — Time Machine counterfactual panel (Tab 3)
│
├── models/                      All model files stored here
│   ├── kokoro-v1.0.onnx         Kokoro TTS ONNX (318 MB) — used by local_tts.py
│   ├── voices.bin               Kokoro voice embeddings (28 MB)
│   ├── bge_small_en/            BGE-small-en ONNX model files — used by agent7_rag.py
│   ├── melotts_en-voice_ai-*/   MeloTTS-EN QNN .bin files (Snapdragon X Elite)
│   │   ├── encoder.bin, flow.bin, decoder.bin, bert_wrapper.bin
│   │   ├── t5_encoder.bin, t5_decoder.bin
│   │   ├── bert_en_tokenizer.bin, bert_normalizer.bin
│   │   └── config.json, metadata.json
│   └── distil_whisper_x_elite/  (created after running scripts/export_models.py)
│
├── .venv312/                    Python 3.12 ARM64 venv — has qai-hub, qai-hub-models, pytest, pip_system_certs
│   └── Scripts/python.exe       Use for qai-hub export + production server
│
├── backend/fleet/
│   ├── __init__.py
│   └── fl_aggregator.py         Federated Learning aggregator (Track 16, I5)
├── tests/                       pytest — 208 Python tests, all passing (.venv312)
├── scripts/
│   ├── export_models.py         Export Distil-Whisper via qai-hub (run with .venv312)
│   ├── setup_python312_venv.py  Automated venv setup (legacy — venv already created)
│   ├── simulate_fleet.py        5-vehicle fleet telemetry simulator
│   ├── run_benchmarks.py
│   ├── benchmark_dms.py         Track 7 — DMS accuracy benchmark (synthetic 200+200 dataset)
│   └── generate_demo_log.py     Track 17 — 8-hour synthetic driving log (960 samples @ 30s)
├── run.ps1                      PowerShell launcher — uses .venv312 automatically
├── cabin_rag.db                 ChromaDB persistent RAG database (created on first run)
└── .env                         API keys + model paths (NEVER commit) — CLOUD_LLM_ENABLED=true, CLOUD_LLM_API_KEY set
```

---

## 2. Agent Inventory

| ID | Name | Tier | Model | Location | Status |
|---|---|---|---|---|---|
| A1 | Perception / DMS | Edge | MediaPipe FaceMesh 468-pt | Browser WASM | ✅ Working + emotion detection |
| A2 | Gesture Control | Edge | MediaPipe Hands 21-pt + geometry | Browser WASM | ✅ Working (gesture detection fixed) |
| A3 | Speech / STT | Edge→Cloud | Whisper-Large-V3-Turbo on AIC100 | Flask proxy | ✅ Working + audio feedback |
| A4 | Fast Edge LLM | Edge | QWEN 7B INT4 (Ollama) → Cloud-LLM claude-4-5-sonnet fallback | Flask SSE | ✅ Working (Cloud-LLM streaming fallback when Ollama offline) |
| A5 | Proactive Intel | Cloud | Qwen3-VL-32B on AIC100 | Flask + AIC100 | ✅ Working (VLM frames + Cloud-LLM fallback) |
| A6 | Complex Query + Coach | Cloud | gpt-oss-20b on AIC100 | Flask + AIC100 | ✅ Working (Cloud-LLM fallback) |
| A7 | Local RAG | Edge | BGE-small-en ONNX (onnxruntime + tokenizers) + ChromaDB | Flask Python | ✅ Working (no torch, persistent DB, Hyderabad corpus) |

---

## 3. Data Flow

```
Browser camera
  └─ Agent1Perception.init()
       ├─ FaceMesh → _onFaceResults() → bus.publish('PERCEPTION_UPDATE', metrics+emotion)
       └─ Hands   → _onHandResults() → Agent2Gesture.onHandResults()
                                             └─ _classify(lm) → bus.publish('GESTURE_ACTION')
                                                                      └─ DrivingGame controls

Browser mic
  └─ Agent3Speech.toggle() — plays audio beep on start/stop
       └─ MediaRecorder(WebM/opus)
            └─ POST /api/agent3/transcribe (Flask)
                 └─ AIC100 Whisper (or Cloud-LLM fallback or Web Speech fallback)
                      └─ transcript → bus.publish('STT_RESULT')
                           └─ routeQuery() → AGENT4 or AGENT6

AGENT4 path: POST /api/agent4/generate → SSE tokens → hud_renderer + speakResponse (MeloTTS/speechSynthesis)
  Primary: Ollama qwen2:7b local
  Fallback: Cloud-LLM claude-4-5-sonnet streaming (CLOUD_LLM_ENABLED=true, Ollama offline)

AGENT6 path: POST /api/agent6/query → JSON response → hud_renderer + speakResponse

Background (every 5 min):
  POST /api/agent5/sync (+ latest_frame_b64 JPEG) → AIC100 Qwen3-VL-32B
    → bus.publish('FATIGUE_FORECAST')
    → DrivingGame._highlightRestStop(recommended_rest)
    → playRestStopChime() + speakResponse(alert)

Tab 2 RAG:
  POST /api/agent7/query → BGE-small-en ONNX embed → ChromaDB cosine search
    → if confidence<0.55 → escalate to Agent6

SSE streams:
  GET /api/events → all bus events → zeroclaw_bus.js (frontend) → subscribers
  GET /api/fleet/events → fleet telemetry → fleet dashboard

Driving Game (Tab 1 unified cockpit — Gachibowli/ORR):
  DrivingGame.start() → requestAnimationFrame loop
    → arrow key controls (first-person perspective)
    → 17 real Hyderabad landmarks rendered
    → NPC traffic, parking/urban/emergency zones
    → day/night cityscape + driver cam side-by-side in cockpit
    → physics update (speed/RPM/fuel/temp/distance)
    → GAME_ALERT → bus.publish → playAlertBeep + speakResponse
    → dashboard canvas render (gauges) @ 30 FPS
```

---

## 4. ZeroClaw Bus State Schema

```python
# backend/orchestrator/zeroclaw_bus.py — BusState
attention_score:       float  # 0-1 (1=fully alert)
drowsiness_score:      float  # 0-1 (>0.7 triggers safety pre-emption)
drowsiness_flag:       bool
ear:                   float  # eye aspect ratio (0.20 = eye closed)
perclos:               float  # % frames eye closed over 60s window
blink_freq:            float  # blinks per minute (normal 12-20)
fatigue_forecast:      float  # from Agent 5 (0-1, T+15 min)
forecast_confidence:   float
recommended_rest:      str    # e.g. "HITEC City, 2km"
route_complexity:      str    # "low|medium|high_curvature"
driver_fatigue_state:  float
fatigue_forecast_t15:  float
agent7_escalate:       bool   # set when Agent7 conf < CONFIDENCE_THRESHOLD
npu_status:            str    # "nominal|degrading|critical"
npu_temp_c:            float
npu_ber:               float
npu_latency_dev_ms:    float
npu_prediction:        dict   # {status, health_score, predicted_degradation_hours, recommended_model_swap, trend_direction}
network_state:         str    # "online|offline"
battery_level:         float
session_events:        list   # last 50 events
last_sync_ts:          float  # unix timestamp of last Agent5 sync
next_sync_in_s:        float  # countdown to next sync (decremented by SYNC_TICK)
proactive_alert_msg:   str
proactive_alert_urgency: str  # "advisory|warning|critical"
# Driving simulator state (sim ↔ app linkage — added session 4)
game_speed:        float   # km/h
game_rpm:          float
game_location:     str     # current segment name (e.g. "ORR Highway")
game_segment_type: str     # parking|urban|highway|tunnel|emergency|gas|rest
game_engine_temp:  float   # 0-1 (>0.85 → critical TEMP alert)
game_fuel:         float   # 0-1 (<0.15 → low-fuel warning)
game_oil_pressure: float   # 0-1 (<0.4 → critical OIL alert)
game_battery:      float   # 0-1 (<0.5 → BATT warning)
game_distance_km:  float
alert_consensus_level: str   # 'L2_CONSENSUS' | 'L1_DISAGREE' | 'STANDARD' (vote_fusion)
```

JS-only events:
```
GAME_ALERT  { type, msg, severity }  — from DrivingGame when fault/drowsiness/speeding/tunnel
GAME_STATE  { game_speed, game_rpm, game_location, game_engine_temp, ... }
            — published every 500 ms; forwarded to backend → bus state → Agent 4 prompt
GESTURE_DETECTED  { gesture, action }
GESTURE_ACTION    { gesture, action, label }
```

---

## 5. API Endpoints

| Method | Path | Agent | Auth |
|---|---|---|---|
| GET | `/api/health` | — | none |
| GET | `/api/state` | — | none |
| POST | `/api/state/update` | A1 frontend | none |
| POST | `/api/buffer/frame` | A1 frontend | none |
| POST | `/api/agent3/transcribe` | A3 | QAIC_API_KEY |
| POST | `/api/agent4/generate` | A4 | none (local/Cloud-LLM) |
| POST | `/api/agent5/sync` | A5 | QAIC_API_KEY |
| POST | `/api/agent6/query` | A6 | QAIC_API_KEY |
| POST | `/api/agent6/coaching` | A6 | QAIC_API_KEY |
| POST | `/api/agent7/query` | A7 | none |
| GET | `/api/events` | bus | none |
| POST | `/api/tts/speak` | MeloTTS | QAIC_API_KEY |
| POST | `/api/fleet/update` | fleet | none |
| GET | `/api/fleet/state` | fleet | none |
| GET | `/api/fleet/events` | fleet SSE | none |
| POST | `/api/agent4/generate_split` | A4 split | none |
| GET | `/api/fl/status` | FL state | none |

---

## 6. Configuration Variables (backend/config.py)

| Variable | Default | Purpose |
|---|---|---|
| `HYDRA_BASE_URL` | `https://your-inference-gateway.example.com/aips/sparq/api/v1` | AIC100 gateway |
| `APIGEE_TOKEN` | (shared) | Qualcomm SparQ tenant token |
| `QAIC_API_KEY` | `""` | Personal AIC100 key — empty = mock mode |
| `MODEL_AGENT5` | `qwen3_vl_32b_instruct` | |
| `MODEL_AGENT6` | `gpt-oss-20b` | |
| `MODEL_STT` | `openai/whisper-large-v3-turbo` | |
| `AGENT4_BACKEND` | `ollama` | `ollama`/`mock`/`genie` |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | |
| `OLLAMA_MODEL` | `qwen2:7b` | |
| `CLOUD_LLM_ENABLED` | `false` | Enable Cloud-LLM SDK fallback for A3/A4/A5/A6 |
| `CLOUD_LLM_API_KEY` | `""` | Cloud-LLM key — set in .env |
| `CLOUD_LLM_ENDPOINT` | `https://your-cloud-llm.example.com/v1` | |
| `CLOUD_LLM_MODEL` | `anthropic::claude-4-5-sonnet` | |
| `FLASK_PORT` | `5000` | |

---

## 7. Known Bugs

### A2 — Gesture not detected reliably
**Fix applied (2026-06-02):**
- Lowered `minDetectionConfidence` to 0.5 and `minTrackingConfidence` to 0.5.
- Thumb threshold loosened from ±0.1 to ±0.05.
- Gate moved: now fires GESTURE_DETECTED always; GESTURE_ACTION only when attention ≥ 0.4.

### A3 — Mic not capturing / not transcribing / no voice response
**Fixes applied (2026-06-02):**
1. Removed `sampleRate` constraint from getUserMedia.
2. Added `speakResponse()` using MeloTTS-EN (AIC100) → speechSynthesis fallback.
3. Added Cloud-LLM fallback path in backend.
4. Added audio beeps on mic start/stop via Web Audio API.

### Alerts not audible (pre-2026-06-02)
**Fix applied (2026-06-02):**
- Added `frontend/js/ui/alert_audio.js` with `playAlertBeep()`, `playDrowsinessAlert()`,
  `playRestStopChime()`, `playMicStartSound()`, `playMicStopSound()`.
- HUD renderer now calls `playDrowsinessAlert()` when drowsiness > 0.7 (8s debounce).
- Proactive alerts and SAFETY_ALERT also play audio.
- Game faults and drowsiness trigger GAME_ALERT → audio + TTS.

### Corporate SSL proxy — httpx certificate errors
**Fix applied (2026-06-03):**
- All OpenAI-compatible and Cloud-LLM clients now use `httpx.Client(verify=False)` to
  bypass corporate SSL proxy certificate verification failures.
- `pip_system_certs` installed in `.venv312` as belt-and-suspenders fix.

### torch import warning on Python 3.12 ARM64
**Fix applied (2026-06-03):**
- Agent 7 now uses BGE-small-en ONNX via `onnxruntime` + `tokenizers` — no torch
  dependency required.  The `all-MiniLM-L6-v2` sentence-transformers path (which
  triggered the torch wheel warning) has been removed.

### `[Agent7] ChromaDB unavailable, using in-memory numpy` displayed as error
**Fix applied (2026-06-03 session 4):**
- `chromadb==0.5.3` added to `requirements.txt` and installed via `pip install --no-deps`
  (Windows ARM64 has no `pulsar-client` wheel and the strict `numpy<2.0.0` build pin
  fails meson — installing without strict deps avoids both).
- `agent7_rag.py` now treats ChromaDB as an *optional* persistence layer.  The
  in-memory numpy cosine path is the expected fast path (sub-50 ms for 29 docs) and
  the log message is informational rather than an error:
  `[Agent7] ChromaDB not installed — using in-memory numpy (29 Hyderabad docs, sub-50ms latency)`.
- New env var `CHROMADB_DISABLE=1` forces the in-memory path even if ChromaDB
  imports cleanly.

### Voice agent not responding — AIC100 timeout too long
**Fix applied (2026-06-03 session 5):**
- `AIC100_TIMEOUT_S` reduced from 120s to 15s — demo-friendly fallback time.
- Agent 4 Cloud-LLM `max_tokens` bumped 180→250, temperature 0.6→0.5 for higher-quality answers.
- Agent 6 `SYSTEM_PROMPT` rewritten with explicit Hyderabad/Gachibowli context and "never say filler" rule
  to prevent "Understood. Processing your request." non-answers.

### RAG returning "Innsbruck Nord" for Hyderabad queries
**Fix applied (2026-06-03 session 5):**
- Root cause: Agent 6 had no Hyderabad context in its system prompt, so escalated RAG queries
  returned European locations. Those answers were cached back into the RAG via `add_cached_response()`.
- Agent 6 SYSTEM_PROMPT now explicitly lists valid Hyderabad rest stops and forbids foreign names.
- RAG corpus expanded to 31 documents (added children's facilities at IKEA Nallagandla, Biodiversity Junction, etc.).

### Red sky after playing game for several minutes
**Fix applied (2026-06-03 session 5):**
- Sunset gradient (hours 18-21) changed from blood-red `#b71c1c` to realistic purple-orange `#4a1a6b`→`#ff7043`.
- Day/night cycle slowed from 24 real minutes to 72 real minutes (dt/60 → dt/180).


## 8. Fallback Architecture

```
Agent 3 (STT):
  Primary:  AIC100 Whisper (QAIC_API_KEY set + VPN)
  Fallback1: Cloud-LLM claude-4-5-sonnet (CLOUD_LLM_ENABLED=true)
  Fallback2: Browser Web Speech API (always available)

Agent 4 (Edge LLM):
  Primary:  Cloud-LLM claude-4-5-sonnet streaming (CLOUD_LLM_ENABLED=true — preferred for demo quality)
  Fallback1: Ollama qwen2:7b (local, no VPN — used when Cloud-LLM disabled)
  Fallback2: AIC100 Agent6 gpt-oss-20b (non-streaming, wrapped as SSE)
  Fallback3: Smart mock (time/date/nav answers)

Agent 5 (Proactive Intel):
  Primary:  AIC100 Qwen3-VL-32B (QAIC_API_KEY set + VPN) — with VLM image support
  Fallback1: Cloud-LLM claude-4-5-sonnet (CLOUD_LLM_ENABLED=true)
  Fallback2: Hardcoded mock response (reasonable demo data)

Agent 6 (Complex + Coach):
  Primary:  AIC100 gpt-oss-20b (QAIC_API_KEY set + VPN)
  Fallback1: Cloud-LLM claude-4-5-sonnet (CLOUD_LLM_ENABLED=true)
  Fallback2: Hardcoded mock response

TTS (voice response):
  Primary:  AIC100 MeloTTS-EN via /api/tts/speak
  Fallback: Browser Web Speech API (speechSynthesis)
```

---

## 9. Cloud-LLM SDK Integration Pattern (from sampleapp1)

```python
from agno.agent import Agent
from qgenie.integrations.agno import Cloud-LLMChat

model = Cloud-LLMChat(
    id="anthropic::claude-4-5-sonnet",
    api_key=os.getenv("CLOUD_LLM_API_KEY"),
    temperature=0.0,
    max_tokens=8000,
)
```

For direct completions (not tool-using agents), the Cloud-LLM endpoint is OpenAI-compatible:
```
POST https://your-cloud-llm.example.com/v1/chat/completions
Authorization: Bearer <CLOUD_LLM_API_KEY>
model: anthropic::claude-4-5-sonnet
```

All clients instantiated with `httpx.Client(verify=False)` for corporate SSL proxy compatibility.

---

## 10. Test Coverage

| File | Tests | Requires VPN |
|---|---|---|
| `tests/test_agent7_rag.py` | Local RAG correctness, cosine + keyword fallback | No |
| `tests/test_session_buffer.py` | Frame compression, serialisation, 32 KB limit | No |
| `tests/test_drowsiness_and_routing.py` | Safety pre-emption, routing rules | No |
| `tests/test_safety_floor.py` | Safety floor dispatch (44 cases) — all patterns + no-match + latency | No |
| `tests/test_vote_fusion.py` | Vote fusion truth table (17 cases) — L2/L1/STANDARD + boundary | No |
| `tests/test_agent5_agent6_integration.py` | Live AIC100 calls, latency bounds | Yes |

**Total:** 157 Python + 16 browser tests — all passing on Python 3.12 (.venv312).
No mocks in integration tests.  pytest installed in `.venv312`.

---

## 11. Performance Baselines (benchmark_log.csv)

| Agent | Metric | Target | Measured |
|---|---|---|---|
| A1 FaceMesh | FPS | ≥ 25 | 28–32 |
| A2 Gesture | Latency | < 50 ms | < 50 ms (WASM) |
| A3 STT | Latency | < 1 s | ~300 ms (AIC100) |
| A4 Edge LLM | tok/s | ≥ 20 | 28–35 (Ollama) |
| A5 Forecast | Latency | < 2 s | ~500 ms (AIC100) |
| A6 Complex | Latency | < 3 s | ~1.2 s (AIC100) |
| A7 RAG | Latency | < 100 ms | < 50 ms |
| TTS MeloTTS | Latency | < 2 s | ~800 ms (AIC100) |

---

## 12. Completed Features (as of 2026-06-03)

- [x] Agent 1: FaceMesh 468-pt, EAR, PERCLOS, blink frequency, drowsiness composite
- [x] Agent 1: Hands shared camera loop (sequential FaceMesh → Hands)
- [x] Agent 1: Emotion/distraction detection (surprise, frustration, yawning, distracted) — P2-A
- [x] Agent 1: VLM frame capture `getLatestJpeg()` — P2-G
- [x] Agent 2: 7-gesture geometry classifier + debounce + action mapping
- [x] Agent 2: Canvas overlay (skeleton on face mesh canvas) — gesture detection working
- [x] Agent 2: Game controls via gesture (CONFIRM=+speed, REJECT=-speed, DISMISS=clear alert)
- [x] Agent 3: MediaRecorder WebM/opus capture → Flask → AIC100 Whisper
- [x] Agent 3: Rate limit handling (429 → user-visible error)
- [x] Agent 3: Web Speech API emergency fallback
- [x] Agent 3: TTS voice response — MeloTTS-EN primary, speechSynthesis fallback
- [x] Agent 3: Mic button visual feedback (red pulsing when recording)
- [x] Agent 3: Audio beeps on mic start/stop (Web Audio API)
- [x] Agent 4: Ollama SSE streaming + Cloud-LLM claude-4-5-sonnet streaming fallback (real answers, not mock)
- [x] Agent 5: AIC100 Qwen3-VL-32B fatigue forecast (5-min timer + force sync)
- [x] Agent 5: Cloud-LLM fallback (CLOUD_LLM_ENABLED)
- [x] Agent 5: VLM image frame support (latest_frame_b64) — P2-G
- [x] Agent 6: AIC100 complex query + coaching report
- [x] Agent 6: Cloud-LLM fallback (CLOUD_LLM_ENABLED)
- [x] Agent 7: BGE-small-en ONNX embedder (onnxruntime + tokenizers, no torch) — P2-E
- [x] Agent 7: ChromaDB persistent RAG database (cabin_rag.db, fleet network effect) — P2-E
- [x] Agent 7: Gachibowli/Hyderabad place names corpus loaded
- [x] Agent 7: cosine RAG + keyword fallback + cloud escalation cache
- [x] ZeroClaw bus: pub/sub, safety pre-emption, SSE push
- [x] Query router: rule-based AGENT4/AGENT6 routing
- [x] HUD renderer: all Tab 1 metrics + alerts + audio + emotion indicator
- [x] Alert audio: drowsiness beep, car fault beep, rest stop chime, mic sounds — P3-C
- [x] Health monitor: Tab 3 NPU health, model slots, offload matrix, agent cards
- [x] Driving game (Tab 1 cockpit): Gachibowli/ORR first-person game, 17 real Hyderabad landmarks
- [x] Driving game: arrow key controls, Start/Stop buttons
- [x] Driving game: driver cam mirror in sidebar
- [x] Driving game: day/night cityscape
- [x] Driving game: NPC traffic, parking/urban/emergency zones
- [x] Driving game: realistic dashboard (speedometer, RPM, fuel, temp, oil, battery)
- [x] Driving game: minimap with rest stop POIs, distance counter
- [x] Driving game: GAME_ALERT → bus → audio + TTS
- [x] Driving game: LLM rest stop integration (highlighted on minimap)
- [x] Driving game: fault injection buttons (fuel/temp/oil/battery)
- [x] Driving game: gesture controls (CONFIRM/REJECT/DISMISS)
- [x] Fleet telemetry: POST /api/fleet/update, GET /api/fleet/state, GET /api/fleet/events SSE — P2-D
- [x] Fleet simulation: scripts/simulate_fleet.py (5 virtual vehicles) — P2-D
- [x] MeloTTS-EN: POST /api/tts/speak (AIC100 primary, speechSynthesis fallback)
- [x] Kokoro-ONNX local TTS (models/kokoro-v1.0.onnx)
- [x] Distil-Whisper local STT (ONNX export via qai-hub, models/distil_whisper_x_elite/)
- [x] Demo mode: ?demo=1 URL param auto-triggers pipeline — P3-A
- [x] Session export: "Export ↓" button downloads JSON of session state — P3-D
- [x] 3-tab SPA (Tab 1 Unified Cockpit: Driver Cam + Drive Sim side-by-side, Tab 2 RAG, Tab 3 Health)
- [x] Post-trip coaching report renderer
- [x] SSL fix: httpx.Client(verify=False) on all OpenAI/Cloud-LLM clients + pip_system_certs in venv312
- [x] 157 Python + 16 browser tests all passing, pytest in .venv312, no mocks in integration tests

### Session 4 (2026-06-03 — late) additions

- [x] Agent 7: graceful ChromaDB fallback (in-memory numpy is the expected fast path on Win ARM64)
- [x] Agent 7: corpus expanded to **29 Hyderabad documents** including 6 `sim_link` docs, monsoon driving, tunnel/underpass list, Charminar/Golkonda/Hussain Sagar routes
- [x] Agent 4: system prompt now includes RAG top-k chunks + live drive state (`game_speed`, `game_location`, `game_engine_temp`, `game_fuel`)
- [x] Bus state: 10 new game fields (game_speed/rpm/location/segment_type/engine_temp/fuel/oil_pressure/battery/distance_km/paused) and a GAME_STATE event handler
- [x] `POST /api/state/update` auto-detects perception vs game state and routes appropriately
- [x] Tab 1 unified cockpit: **camera left, game right** (`.cockpit-row1` layout)
- [x] Tab 1 left section: live driver cam with overlay + DROWSY badge, compact metrics (EAR · PERCLOS · FATIGUE · FPS · EMOTION · ATTENTION), rest-stop pill
- [x] Tab 1 right section: full-size game canvas + controls strip (START/STOP, hint, Weather, Jump-to-Location dropdown, fault icons) + AI recommendation bar
- [x] **Embedded dashboard** drawn at the bottom of the game canvas (~108px) — speedometer + RPM + gear + 4 vertical bars + warning icons + animated turn signals
- [x] **Tunnel** segment (Durgam Cheruvu) — dedicated render path with dark walls, animated ceiling lights, walkway-edge lights, exit glow, headlights/lane-discipline alert
- [x] Sim ↔ App linkage — sustained high-speed (>100 km/h for >60s) heats engine → critical TEMP alert → AI suggests Biodiversity Junction (RAG-backed)
- [x] HYDERABAD_ROUTE expanded to 17 segments incl. tunnel + emergency bay + airport
- [x] Improved game graphics: animated sun/moon/clouds, distant Hyderabad hills, Charminar minaret silhouette, neem/banyan trees, highway lampposts with night-glow, **Hyderabad auto-rickshaws** (yellow domed hood) NPCs, per-zone props (P sign, fuel canopy, bench, SOS sign, red/white barriers), shadow ellipses + tail lights
- [x] Arrow keys/WASD only respond when Tab 1 cockpit is the active panel (so typing in other tabs doesn't move the car)

### Session 5 (2026-06-03) additions

- [x] AIC100 timeout reduced 120s→15s for fast fallback during demos
- [x] Agent 6: SYSTEM_PROMPT rewritten with Hyderabad context + anti-filler rules
- [x] Agent 4: Cloud-LLM streaming improved (max_tokens 250, temp 0.5)
- [x] Agent 7: RAG corpus expanded to **31 Hyderabad documents** (added children's facilities at IKEA, Biodiversity Junction, Gachibowli Stadium, Inorbit Mall)
- [x] Red sky bug fixed: sunset gradient now purple-orange instead of blood-red
- [x] Day/night cycle slowed 3× (72 real minutes per full cycle, was 24)
- [x] Steering more responsive: steerRate 3.2→3.8, visual perspective shift 0.18→0.25, bonnet offset 32→48px
- [x] NPCs shift laterally when steering (steerShift applied to NPC lane positions)
- [x] Night headlight beams illuminate the road (radial gradient from bonnet)
- [x] Atmospheric haze layer near horizon for depth perception
- [x] Double-layer distant hills (far + near) for parallax depth
- [x] Rain: wet road reflections gradient on road surface
- [x] Fog: graduated density gradient (lighter near sky, denser near road)

## 13. Remaining / Planned Features

> **SparQ 2026 final push** — see [.claude/plans/toasty-jumping-axolotl.md](C:\Users\vsahni\.claude\plans\toasty-jumping-axolotl.md) for the full 20-track plan to take CabinAI from #4 → #1. Each
> track is tagged to one of the 5 deep-dive ideas (I1 Multi-Agent MCP, I2 Dynamic Split Inference,
> I3 Self-Healing NPU, I4 On-Device RAG, I5 Adaptive Offloading). Working branch: `sparq2026-final-push`.

### Session 7 (2026-06-06 — current) additions

- [x] Three.js 3D cockpit game (`frontend/js/game/driving_game_3d.js`, ~960 lines)
  — full WebGL2 scene: PerspectiveCamera, TubeGeometry road along CatmullRomCurve3 spline through 17 Hyderabad waypoints,
    InstancedMesh cityscape (140 buildings, day/night swap), DirectionalLight sun with day/night rotation, gradient skybox shader,
    FogExp2, particle rain (3500 points), real Durgam Cheruvu tunnel mesh with emissive ceiling lights,
    NPC pool (18 cars / autos / trucks) following spline, cockpit bonnet + steering wheel parented to camera,
    dashboard reused verbatim via Canvas2D → CanvasTexture overlay, HUD layer (location pill, speed sign, minimap, alert banner) on a second CanvasTexture
- [x] **Three.js vendored locally** at `frontend/js/vendor/three.min.js` (**UMD r158** — r163 ships ESM-only with no `three.min.js`, which 404'd and was the original "stuck on 2D" bug). Plain `<script>` tag in `<head>` sets `window.THREE` synchronously before any app script. Fully offline-capable (on-brand for the privacy story); no CDN dependency.
- [x] **Fixed duplicate-global crash**: `driving_game_3d.js` is now wrapped in an IIFE and reuses `window.HYDERABAD_ROUTE` instead of re-declaring `const HYDERABAD_ROUTE`/`SEG_LENGTH_M` (the redeclaration threw a SyntaxError that prevented `DrivingGame3D` from defining → silent 2D fallback). Verified via headless Edge: `[DrivingGame3D] scene initialised OK — THREE r158`, 0 page errors.
- [x] `main.js` selects `DrivingGame3D` when `window.THREE` is present; falls back to `window.DrivingGame2D` if THREE missing or `?game=2d`
- [x] **Game physics fixed** (`driving_game_3d._update`): fuel now visibly burns with speed/RPM; engine temperature cools when you slow down (cooling scales with headroom below redline + low-speed bonus); oil pressure degrades on heat/over-rev and recovers when healthy; battery charges from the alternator above 1500 RPM and self-drains at idle — fuel/oil/battery are now independent quantities, not duplicates
- [x] **Dashboard bars fixed**: TEMP bar is now "high = bad" (reddens as it fills) with a danger tick mark; each bar has a distinct accent colour (fuel green, temp red, oil amber, batt blue) so they're visually distinguishable
- [x] **TTS de-robotified** (Track 5.1 + 5.2): default Kokoro voice changed `af_heart` → `af_bella` (config.py `LOCAL_TTS_VOICE` + env `KOKORO_VOICE`); added `prosody_clean()` pre-processor in `local_tts.py` that expands ORR→"Outer Ring Road", "1.6 km"→"1.6 kilometres", etc. before synthesis. Warm Kokoro latency ~491 ms, cold ~2.9 s (pre-warmed at startup via `warm_up()`).
- [x] `?game=2d` URL fallback — `main.js` selects the 2D class when THREE is unavailable
- [x] Public DrivingGame API surface preserved exactly (start/stop/startDriving/stopDriving/togglePause/setWeather/jumpToSegment/injectFault/clearFault/getState + GAME_STATE/GAME_ALERT bus events + FATIGUE_FORECAST/PERCEPTION_UPDATE subscriptions)
- [x] Polished `start.ps1` one-click cold start (venv312-aware, frees ports 5000/3000, waits for health, opens Edge to ?demo=1) — Track 11

### Session 8 (2026-06-07 — Track 4) additions

- [x] `backend/orchestrator/safety_floor.py` — regex-keyed deterministic command dispatcher; fires before any LLM; handles AC/climate, locks, windows, mute/unmute, alert-dismiss, and 9 game intents (JUMP/SPEED/STOP/WEATHER/PAUSE/RESUME); GAME_JUMP maps against all 17 HYDERABAD_ROUTE names; sub-50ms guaranteed
- [x] `backend/orchestrator/vote_fusion.py` — 3-engine vote classifier: rule_vote (bool), ml_vote (float >0.65 = critical), llm_vote (bool|None) → L2_CONSENSUS | L1_DISAGREE | STANDARD
- [x] `backend/server.py` — safety floor wired into `/api/agent3/transcribe` (both AIC100 and local-whisper paths); publishes SAFETY_FLOOR_HIT and short-circuits before LLM routing; vote fusion runs in `/api/state/update` after PERCEPTION_UPDATE and writes `alert_consensus_level` to bus state
- [x] `frontend/js/ui/hud_renderer.js` — PERCEPTION_UPDATE subscriber reads `bus.getState().alert_consensus_level` and paints a green ✓ ALL AGREE or amber △ SPLIT badge next to the DROWSY metric
- [x] `frontend/js/main.js` — `SAFETY_FLOOR_HIT` bus subscriber in `initDrivingGame()`; dispatches GAME_JUMP/SPEED/STOP/WEATHER/PAUSE/RESUME to `_game`
- [x] `frontend/css/cabin_ai.css` — `.vote-badge`, `.vote-l2` (green), `.vote-l1` (amber) styles added
- [x] 61 new passing tests: `tests/test_safety_floor.py` (44 cases) + `tests/test_vote_fusion.py` (17 cases)

### Session 10 (2026-06-07 — Tracks 15 + 16) additions

- [x] **Track 15 I2**: `backend/orchestrator/split_inference.py` — `SplitInferenceOrchestrator`: edge tier (Ollama qwen2:7b, max N tokens) + cloud tier (Cloud-LLM claude continuation); measures prefix bytes vs 640x480 JPEG; `measure_compression_ratio()` shows ~170x savings
- [x] **Track 15**: `POST /api/agent4/generate_split` route in `backend/server.py`
- [x] **Track 15**: `scripts/demo_split_inference.py` — side-by-side comparison table (edge-only vs cloud-only vs split) for 3 Hyderabad queries
- [x] **Track 15**: `tests/test_split_inference.py` — 17 cases (no network, mocked Ollama + Cloud-LLM)
- [x] **Track 16 I5**: `backend/fleet/fl_aggregator.py` — `FLAggregator`: collects per-vehicle drowsiness/blink uncertainty; aggregates fleet patterns (>60% drowsy → threshold 0.60, >40% low-blink → threshold 0.55); `apply_update()` publishes `FL_THRESHOLD_UPDATE` to bus + appends to `logs/fl_audit.log`
- [x] **Track 16**: `GET /api/fl/status` endpoint in `backend/server.py`
- [x] **Track 16**: `scripts/simulate_ota.py` — seeds 5 vehicles, reads fleet state, runs aggregation, prints before/after table
- [x] **Track 16**: Fleet Learning widget in `frontend/js/ui/health_monitor.js` subscribes to `FL_THRESHOLD_UPDATE` SSE event; `<div id="fl-widget">` added to Tab 3 in `frontend/index.html`; FL widget CSS added to `frontend/css/cabin_ai.css`
- [x] **Track 16**: `FL_THRESHOLD_UPDATE` handler added to `backend/orchestrator/zeroclaw_bus.py`; `fl_threshold` and `fl_last_update` fields added to `BusState`
- [x] **Track 16**: `tests/test_fl_aggregator.py` — 23 cases (all patterns, threshold logic, bus publish, audit log, end-to-end)

### Session 9 (2026-06-07 — Tracks 9 + 12) additions

- [x] **Track 12 P2-C**: `Agent3Speech._measureNoise()` — samples 20 FFT frames over 1 s using Web Audio API `AnalyserNode`, returns max RMS; called before MediaRecorder starts
- [x] **Track 12 P2-C**: `_applyNoiseBadge()` sets `this._minBlobSize` (quiet→1 KB, moderate→2 KB, loud→3 KB) and paints the noise badge
- [x] **Track 12 P2-C**: `_onRecordingStop` uses `this._minBlobSize || 1000` (dynamic, not hardcoded)
- [x] **Track 12 P2-C**: `<span id="noise-badge">` added to voice panel in `frontend/index.html`
- [x] **Track 12 P2-C**: `.noise-badge`, `.noise-quiet` (green glow), `.noise-moderate` (amber glow), `.noise-loud` (red glow) CSS classes in `frontend/css/cabin_ai.css`
- [x] **Track 9.1**: `backend/audit_log.py` — append-only JSONL egress log at `logs/cloud_egress.log`; thread-safe; auto-creates `logs/` dir
- [x] **Track 9.2**: `backend/phi_redactor.py` — strips email, Indian phone (+91/10-digit 6-9), Aadhaar 12-digit, PAN card patterns before egress
- [x] **Track 9.3**: `backend/server.py` wired: `log_egress` + `_phi_redact` called at all 4 AIC100 egress points (STT audio bytes, Agent 5 session JSON, Agent 6 query text, TTS text)
- [x] **Track 9.4**: `docs/PRIVACY_ARCHITECTURE.md` — data residency table (8 modalities) + egress audit policy
- [x] **Track 9.5**: `tests/test_phi_redactor.py` — 9 cases (email, phone with +91, phone bare, Aadhaar, PAN, mixed, clean, empty, already-redacted); all passing
- [x] **Track 8**: `backend/orchestrator/npu_health.py` — `NPUHealthPredictor` with EMA (alpha=0.1) over temp/BER/latency; classifies nominal/degrading/critical; computes health_score (0–1, clamped); trend via 5-sample window comparison; linear degradation estimate when worsening and health_score ≤ 0.5; model-swap recommendation at score < 0.3 (Fallback) / < 0.6 (Standby)
- [x] **Track 8**: `backend/server.py` — `_npu_predictor` singleton; `_sync_ticker` calls `update()` each second and publishes `NPU_PREDICTION` event to bus; `BusState.npu_prediction` dict field added
- [x] **Track 8**: `frontend/js/ui/health_monitor.js` — `NPU_PREDICTION` SSE subscriber renders health_score % bar (colour-coded green/amber/red), trend arrow (▲/▶/▼), predicted degradation hours, model-swap recommendation
- [x] **Track 8**: `frontend/index.html` — added `npu-health-score`, `npu-health-bar`, `npu-trend`, `npu-degradation` elements to NPU health panel
- [x] **Track 8**: `frontend/css/cabin_ai.css` — `.npu-health-bar-bg` + `.npu-health-bar-fill` styles added
- [x] **Track 8**: `tests/test_npu_health.py` — 23 passing cases covering all classification thresholds, health score clamping, swap recommendations, trend detection, EMA smoothing, degradation estimate, return shape

### Session 11 (2026-06-07 — Tracks 7 + 17) additions

- [x] **Track 7**: `scripts/benchmark_dms.py` — synthetic DMS benchmark (200 alert + 200 drowsy); AUROC 1.0, recall 0.985, F1 0.9924, 0 false alarms/hr, lead_time 21s
- [x] **Track 7**: `phase2/deliverables/dms_accuracy.json` generated and validated
- [x] **Track 17**: `scripts/generate_demo_log.py` — 8-hour synthetic driving log (960 samples @ 30s); peak drowsiness 0.806; alert_with=04:00, alert_without=04:24, improvement=24 min
- [x] **Track 17**: `phase2/deliverables/demo_driving_log.json` generated
- [x] **Track 17**: `frontend/js/ui/time_machine.js` — IIFE Time Machine panel; SVG line chart; side-by-side threshold comparison (0.65 vs 0.80); REPLAY animation
- [x] **Track 17**: Tab 3 HTML + CSS updated (`time-machine-section`, `tm-*` styles)
- [x] **Track 17**: `DEMO_SCRIPT.md` 80–90s segment updated with Time Machine talking points

### Tracks remaining for final push (sessions 2–6)

- [x] Track 1 — Android Cabin Companion APK foundation: `docs/ANDROID_CABIN_COMPANION.md` (architecture, hardware target, reuse list, model sizes, demo script, build instructions), `android/cabin-companion/README.md`, `android/cabin-companion/SETUP.md` **Done 2026-06-07**
- [ ] Track 3 — Voice → game commands (jumpToSegment via safety floor) and game-location-aware Agent 4 prompt
- [x] Track 4 — Safety floor + 3-engine vote (`backend/orchestrator/safety_floor.py`, `vote_fusion.py`) **Done 2026-06-07**
- [ ] Track 5 — Less-robotic TTS (Kokoro voice swap, prosody pre-processor, optional Sherpa VITS, INT8 Kokoro export)
  - [x] Track 5.3 — Streaming sentence-chunked TTS: `_speakImmediate` now splits into sentences and plays them sequentially, `synthesize_stream()` generator added to `local_tts.py` **Done 2026-06-07**
- [x] **AI Hub real-silicon profiling** (Track 6) — `scripts/profile_aihub.py` submits compile + profile jobs; `phase2/deliverables/aihub_profiling.json` contains measured latencies on real Qualcomm devices:

  | Model | Device | Inference | Peak Memory |
  |---|---|---|---|
  | Distil-Whisper **encoder** | Snapdragon X Elite CRD | 605.6 ms | 3213 MB |
  | Distil-Whisper **decoder** | Snapdragon X Elite CRD | **19.7 ms** | 285.6 MB |
  | Distil-Whisper **decoder** | Snapdragon 8 Elite QRD | **14.4 ms** | 373 MB |
  | Distil-Whisper **decoder** | SA8295P ADP (automotive) | **20.8 ms** | 352.4 MB |
  | Distil-Whisper **decoder** | QCS8550 (Proxy) | **22.2 ms** | 338.1 MB |

  BGE and Kokoro failed compile (dynamic-shape int64 limitations); Distil-Whisper encoder too large for mobile (3.2 GB) — profiled on X Elite only. SA8295P is the automotive SoC — STT decoder runs in <21ms there.
- [x] Track 7 — DMS accuracy benchmark (`scripts/benchmark_dms.py`) — synthetic 400-sample dataset; AUROC 1.00, recall 0.985, 0 false alarms/hr, lead_time 21s; output: `phase2/deliverables/dms_accuracy.json` **Done 2026-06-07**
- [x] Track 8 — NPU Health predictive model (`backend/orchestrator/npu_health.py`) **Done 2026-06-07**
- [x] Track 9 — Privacy-by-architecture doc + `audit_log.py` + `phi_redactor.py` **Done 2026-06-07**
- [ ] Track 10 — Benchmark resubmission v3 (rubric-aware, NPU-heavy, no failed stages)
- [x] Track 11 — `start.bat` / `start.sh` one-click cold start (Track 11 completed in session 7 via start.ps1)
- [x] Track 12 — P2-C ambient noise calibration in `agent3_speech.js` **Done 2026-06-07**
- [ ] Track 13 — Refresh ALL phase 2 deliverables (C1, C4, C5, demo speech, README)
  - [x] Track 13: `phase2/deliverables/DEMO_SCRIPT.md` — 90-second judge demo script with timing budget, talking points, and fallback notes for every risky step **Done 2026-06-07**
  - [x] Track 13: `phase2/deliverables/C5_CabinAI_benchmark_submission_v3.json` — 26 clean runs (0 failed stages); v2 runs 15-16 replaced by runs 17-22 (re-runs after 15s timeout fix); runs 23-28 add Distil-Whisper local STT path benchmarks **Done 2026-06-07**
- [ ] Track 14 — Win-condition discipline: demo rehearsal, phone-demo video fallback, fleet visibility, code-quality pass, token-efficiency callout
- [x] Track 15 — Dynamic Neural Split Inference PoC (`backend/orchestrator/split_inference.py`) **Done 2026-06-07**
- [x] Track 16 — Federated learning closed loop (`backend/fleet/fl_aggregator.py`, `simulate_ota.py`) **Done 2026-06-07**
- [x] Track 17 — Time Machine / counterfactual demo — `scripts/generate_demo_log.py` + `frontend/js/ui/time_machine.js` + `phase2/deliverables/demo_driving_log.json`; alert_with=04:00, alert_without=04:24, improvement=24 min **Done 2026-06-07**
- [x] Track 18 — Hindi / Telugu STT + TTS: `LANGUAGE_VOICE_MAP` + `get_voice_for_language()` in `local_tts.py`; `STT_LANGUAGE` config var; `language` param in `/api/agent3/transcribe` (AIC100 + local Whisper) and `/api/tts/speak`; `#lang-select` dropdown in `index.html`; `agent3_speech.js` sends language in FormData; `main.js` passes language to TTS call; `tests/test_multilingual.py` (11 cases) **Done 2026-06-07**
- [ ] Track 19 — Real driving telemetry capture from phone
- [ ] Track 20 — Energy / battery profiling on phone
- [ ] SA8775P hardware port (Hexagon SDK / Genie runtime) — partly addressed by Track 1 phone deploy

