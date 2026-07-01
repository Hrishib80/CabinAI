# CabinAI — Hybrid Multi-Agent VLA for Automotive In-Cabin Intelligence

**SparQ 2026 Hackathon · Team RoboClaw · Track: Edge + Cloud AI — Automotive · Idea #09**

> A production-grade, 7-agent Vision-Language-Action system that runs continuously in a
> vehicle to monitor driver safety, understand voice commands, recognise hand gestures,
> and surface proactive fatigue alerts — all without a persistent cloud connection.
> Ships with a Gachibowli/Hyderabad driving simulator that ties LLM rest-stop
> recommendations directly to a live in-game map.

---

## 🎬 Demo Video

<p align="center">
  <a href="Screen Recording 2026-07-01 185213 (1).mp4">
    <img src="https://img.shields.io/badge/▶_Watch_Demo-cabinAI__Demo.mp4-2ea44f?style=for-the-badge" alt="Watch the demo">
  </a>
</p>

<p align="center">
  <video src="demoVideo/cabinAI_Demo.mp4" controls width="720">
    Your browser does not support embedded video.
    <a href="demoVideo/cabinAI_Demo.mp4">Download / open the demo video</a> instead.
  </video>
</p>

📁 **File:** [`demoVideo/cabinAI_Demo.mp4`](demoVideo/cabinAI_Demo.mp4) — full end-to-end
walk-through: live driver-camera DMS, gesture control, voice → AIC100 Whisper → Kokoro TTS,
Gachibowli driving simulator with LLM rest-stop recommendations, and post-trip coaching.

---

## ✨ Highlights

- **Edge-first by design** — face-mesh DMS, gesture recognition, RAG, STT and TTS all run
  locally; the cloud path is a graceful escalation, not a dependency.
- **Hybrid hierarchy** — small local LLM (Ollama qwen2:7b) handles fast intents; AIC100
  Qwen3-VL-32B + gpt-oss-20b handle proactive fatigue forecasts and complex coaching.
- **Multi-level fallback chains** — every agent degrades cleanly across 3+ tiers so the
  cabin never goes silent if VPN, NPU, or models are unavailable.
- **Safety pre-emption** — the ZeroClaw bus suspends all non-safety traffic the instant
  `drowsiness_score > 0.7`.
- **Living demo** — Gachibowli ORR driving simulator with 17 real landmarks, fault
  injection, fleet telemetry, and a post-trip coaching report.

---

## Architecture

```
┌─────────────────────── EDGE (SA8775P / Snapdragon X Elite) ────────────────────────┐
│  Agent 1 (Perception)   MediaPipe FaceMesh 468-pt  EAR · PERCLOS · emotion         │
│  Agent 2 (Gesture)      MediaPipe Hands 21-pt       7 gesture classes → actions    │
│  Agent 3 (STT)          AIC100 Whisper-Large-V3 → Distil-Whisper ONNX → Web Speech │
│  Agent 4 (Fast LLM)     Ollama qwen2:7b → Cloud-LLM claude-4-5-sonnet → smart mock    │
│  Agent 7 (Local RAG)    BGE-small-en ONNX embedder → ChromaDB → keyword fallback   │
└────────────────────────────────────────────────────────────────────────────────────┘
                              ↕  ZeroClaw bus (SSE + shared state)
┌─────────────────────────── CLOUD (AIC100 Hydra) ───────────────────────────────────┐
│  Agent 5 (Proactive)    Qwen3-VL-32B-Instruct  → fatigue forecast + VLM frames     │
│  Agent 6 (Complex)      gpt-oss-20b (Qwen3-30B) → complex queries + coaching       │
└────────────────────────────────────────────────────────────────────────────────────┘
        ↕  TTS
┌───────────────────────────── LOCAL AUDIO ──────────────────────────────────────────┐
│  TTS: AIC100 MeloTTS-EN → Kokoro-ONNX → pyttsx3 (Windows SAPI)                    │
│  STT: AIC100 Whisper → Distil-Whisper ONNX (models/distil_whisper_x_elite/)        │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Orchestration:** ZeroClaw bus (pub/sub, thread-safe) with safety pre-emption —
all non-safety traffic is suspended when drowsiness_score > 0.7.

---

## What's Working Right Now

| Feature | Status |
|---|---|
| Face mesh DMS (EAR, PERCLOS, blink, emotion) | Live at 31 FPS, 0 bytes to cloud |
| 7-gesture classifier (Open Palm → Dismiss, etc.) | Geometry-based, <50 ms |
| Voice recording → AIC100 Whisper STT | ~1.6 s via VPN |
| Local STT fallback (Distil-Whisper ONNX) | ~6.5 s on CPU |
| Agent 4 voice response (Cloud-LLM claude-4-5-sonnet) | Natural answers in ~3 s |
| Agent 7 RAG (Gachibowli/Hyderabad corpus) | <50 ms local, cosine + keyword |
| Agent 5 fatigue forecast (5-min sync) | Qwen3-VL-32B with VLM frame |
| Agent 6 complex query + coaching | gpt-oss-20b / Cloud-LLM fallback |
| TTS (Kokoro-ONNX local) | ~1 s warm, real WAV |
| Startup greeting | On first interaction |
| Drive Simulator — Gachibowli ORR route | 17 real landmarks, first-person |
| Drive Simulator — arrow key controls | Steer, accelerate, brake |
| Drive Simulator — Start/Stop buttons | Pause state preserved |
| Drive Simulator — live driver cam mirror | Sidebar, 5 fps |
| Drive Simulator — fault injection | Fuel/Temp/Oil/Battery |
| Drive Simulator — LLM rest recommendation | Highlighted in minimap |
| Alert audio (drowsiness, faults, mic) | Web Audio API beeps |
| Session export JSON | Header button |
| Fleet telemetry SSE | POST /api/fleet/update |

---

## Quick Start

### Prerequisites

| Requirement | Version |
|---|---|
| **Python 3.12 ARM64** | `C:\Users\vsahni\AppData\Local\Programs\Python\Python312-arm64\python.exe` |
| **Node.js 18+** | `node --version` |
| **Edge / Chrome** | Camera + mic permissions |
| **Cisco AnyConnect** → `hydra.qualcomm.net` | Needed for AIC100 (Agent 3/5/6) |

### 1. Configure credentials

```bash
cp .env.example .env
```

Fill in `.env`:
- `QAIC_API_KEY` — from [your-ai-inference-gateway.example.com](https://your-ai-inference-gateway.example.com) → API Keys
- `QGENIE_ENABLED=true` + `QGENIE_API_KEY` — already set in `.env` (Agent 4 fallback)

### 2. Install Python dependencies (in .venv312)

```powershell
.venv312\Scripts\python.exe -m pip install -r requirements.txt
```

### 3. Get model files

Models are tracked via **Git LFS**. After cloning, pull them:

```powershell
git lfs pull
```

This downloads all model files (~1.3 GB total):
- `models/kokoro-v1.0.onnx` — TTS (318 MB)
- `models/voices.bin` — TTS voices (28 MB)
- `models/bge_small_en/onnx/model.onnx` — RAG embeddings (126 MB)
- `models/distil_whisper_x_elite/encoder.onnx` + `decoder.onnx` — STT (633 MB total)
- `models/melotts_en-*/` — MeloTTS QNN binaries (~280 MB)

If Git LFS is not available, download manually:
- **Kokoro TTS**: [github.com/thewh1teagle/kokoro-onnx/releases](https://github.com/thewh1teagle/kokoro-onnx/releases) → `kokoro-v1.0.onnx` + `voices.bin`
- **BGE-small-en**: [huggingface.co/BAAI/bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) → ONNX export
- **Distil-Whisper**: `python scripts/export_models.py` (downloads from HuggingFace)

### 4. Start everything

```powershell
# Backend + frontend + opens Edge browser
.\run.ps1 -frontend
```

Then **hard-refresh** (`Ctrl+Shift+R`) to bypass browser cache.

### 5. Manual start (if run.ps1 doesn't work)

```powershell
# Terminal 1 — backend
.venv312\Scripts\python.exe backend\server.py

# Terminal 2 — frontend
npx serve frontend -p 3000
```

---

## Tabs

### Tab 1 — Unified Cockpit (Driver Cam + Drive Sim)

- Camera runs continuously — FaceMesh + Hands share one stream (left side)
- Drive simulator runs side-by-side (right side) — Gachibowli ORR route
- **MIC button** — click to start, click to stop and transcribe. Always-on checkbox available.
- Voice responses spoken aloud via Kokoro TTS (AIC100 MeloTTS → Kokoro → pyttsx3)
- Sync countdown ticks down; **Force 5-min Sync Now** triggers Agent 5 immediately
- Emotion indicator: neutral / distracted / surprised / frustrated / yawning
- AI Co-pilot bar: live recommendations based on drive state + RAG
- Metrics row: EAR, PERCLOS, blink/min, emotion, attention, drowsiness, FPS, fatigue T+15
- **START** button begins driving; arrow keys / WASD to steer and accelerate
- Route: Gachibowli Stadium → DLF → Financial District → Biodiversity Junction → IKEA → Hi-Tech City → ORR → Shamshabad
- Fault injection: ⛽ Fuel / 🌡 Temp / 🛢 Oil / 🔋 Battery
- LLM rest recommendations from Agent 5 appear in AI bar + minimap

### Tab 2 — Knowledge RAG

- Click a warning-light button for instant offline answer (Agent 7, <50 ms)
- Answers include Hyderabad/Gachibowli place names (DLF Cyber City, Biodiversity Junction, etc.)
- Questions below 0.55 confidence escalate to Agent 6 (AIC100/Cloud-LLM)

### Tab 3 — System Health

- NPU health, model slots, agent cards, offload policy matrix
- **Generate Coaching Report** → Agent 6 post-trip analysis

---

## Supported Gestures

| Gesture | Action |
|---|---|
| Closed Fist | Mute audio |
| Open Palm (✋) | Dismiss alert / game clear alert |
| Pointing Up (☝) | Navigation select |
| Thumb Up (👍) | Confirm / game accelerate |
| Thumb Down (👎) | Reject / game brake |
| Victory (✌) | Accept call |
| I Love You (🤟) | Decline call |

---

## Fallback Chains

```
STT:  AIC100 Whisper-Large-V3 → Distil-Whisper ONNX (local) → Cloud-LLM stub → Web Speech API
TTS:  AIC100 MeloTTS-EN → Kokoro-ONNX (local) → pyttsx3 Windows SAPI
A4:   Ollama qwen2:7b → Cloud-LLM claude-4-5-sonnet → smart mock (time/date/nav answers)
A5:   AIC100 Qwen3-VL-32B (+ VLM frame) → Cloud-LLM claude-4-5-sonnet → mock
A6:   AIC100 gpt-oss-20b → Cloud-LLM claude-4-5-sonnet → mock
A7:   BGE-small ONNX cosine search → in-memory numpy → keyword TF-IDF
```

---

## Running Tests

**Always use Python 3.12 (.venv312):**

```powershell
# All tests (74 Python + 16 browser)
.venv312\Scripts\python.exe -m pytest tests/ -v

# Browser tests (requires backend + frontend running)
node tests\frontend_test.js

# Integration tests (requires VPN + QAIC_API_KEY)
.venv312\Scripts\python.exe -m pytest tests\test_agent5_agent6_integration.py -v
```

---

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `QAIC_API_KEY` | — | Personal AIC100 key (your-ai-inference-gateway.example.com) |
| `APIGEE_TOKEN` | shared | Qualcomm SparQ tenant token |
| `HYDRA_BASE_URL` | `https://your-inference-gateway.example.com/aips/sparq/api/v1` | AIC100 gateway |
| `MODEL_AGENT5` | `qwen3_vl_32b_instruct` | Agent 5 VLM |
| `MODEL_AGENT6` | `gpt-oss-20b` | Agent 6 reasoning model |
| `MODEL_STT` | `openai/whisper-large-v3-turbo` | STT on AIC100 |
| `AGENT4_BACKEND` | `ollama` | `ollama` / `mock` / `genie` |
| `OLLAMA_MODEL` | `qwen2:7b` | Local LLM for Agent 4 |
| `QGENIE_ENABLED` | `true` | Cloud-LLM fallback for Agents 4/5/6 |
| `QGENIE_API_KEY` | set | Cloud-LLM key (anthropic::claude-4-5-sonnet) |
| `KOKORO_ONNX_PATH` | `models/kokoro-v1.0.onnx` | Local TTS model |
| `WHISPER_MODEL_DIR` | `models/distil_whisper_x_elite` | Local STT ONNX + processor |
| `FLASK_PORT` | `5000` | Backend port |

---

## Project Structure

```
cabinai/
├── backend/
│   ├── server.py                    # Flask — 15 REST/SSE endpoints
│   ├── config.py                    # All env-var config
│   ├── agents/
│   │   ├── agent5_proactive.py      # Fatigue forecast (AIC100 Qwen3-VL-32B, VLM frames)
│   │   ├── agent6_complex.py        # Complex query + coaching (AIC100 / Cloud-LLM)
│   │   ├── agent7_rag.py            # RAG — BGE-small ONNX + Hyderabad corpus
│   │   ├── local_whisper.py         # Distil-Whisper ONNX STT (no torch)
│   │   ├── local_tts.py             # Kokoro-ONNX TTS (no torch)
│   │   └── session_buffer.py        # Temporal frame compression (<32 KB)
│   └── orchestrator/
│       ├── zeroclaw_bus.py          # Thread-safe pub/sub state bus
│       └── query_router.py          # Rule-based Agent4/Agent6 routing
├── frontend/
│   ├── index.html                   # 3-tab SPA (Tab 1 = Unified Cockpit)
│   ├── css/cabin_ai.css             # Dark theme + cockpit/game styles
│   └── js/
│       ├── agents/
│       │   ├── agent1_perception.js # FaceMesh + emotion detection + getLatestJpeg()
│       │   ├── agent2_gesture.js    # Hand gesture geometry classifier
│       │   ├── agent3_speech.js     # Mic → AIC100/local STT + audio feedback
│       │   └── agent4_llm.js        # SSE streaming LLM client
│       ├── api/
│       │   └── agent5_client.js     # Agent 5/6/7 REST + VLM frame support
│       ├── game/
│       │   └── driving_game.js      # Gachibowli first-person driving simulator
│       ├── orchestrator/
│       │   ├── zeroclaw_bus.js      # Frontend bus (SSE subscriber)
│       │   └── query_router.js      # JS routing rules
│       └── ui/
│           ├── alert_audio.js       # Web Audio beeps (drowsiness, faults, mic)
│           ├── hud_renderer.js      # Tab 1 metric display + audio triggers
│           └── health_monitor.js    # Tab 3 NPU health
├── models/
│   ├── kokoro-v1.0.onnx             # TTS (318 MB, gitignored)
│   ├── voices.bin                   # TTS voice embeddings (28 MB, gitignored)
│   ├── distil_whisper_x_elite/      # STT ONNX + processor config JSONs
│   ├── bge_small_en/                # Embedding ONNX + tokenizer config
│   └── melotts_en-*/                # QNN .bin files for MeloTTS (needs Qualcomm SDK)
├── tests/
│   ├── test_agent5_agent6_integration.py  # Live AIC100/Cloud-LLM integration
│   ├── test_agent7_rag.py                 # RAG correctness
│   ├── test_drowsiness_and_routing.py     # Safety pre-emption + routing
│   ├── test_session_buffer.py             # Frame compression / 32 KB limit
│   ├── test_game_and_features.py          # Fleet, TTS, VLM, emotion, gestures
│   └── frontend_test.js                   # Real Puppeteer browser tests (16 checks)
├── scripts/
│   ├── export_models.py             # Download Distil-Whisper ONNX from HuggingFace
│   ├── simulate_fleet.py            # 5-vehicle fleet telemetry simulator
│   └── run_benchmarks.py
├── run.ps1                          # One-command launcher (kills port 5000, starts both)
├── .env                             # Credentials (gitignored)
├── .env.example                     # Credential template
└── requirements.txt
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ModuleNotFoundError` on startup | You're on the wrong Python — use `.venv312\Scripts\python.exe` |
| Whisper / Agent 5 / Agent 6 time out | Cisco AnyConnect VPN to `hydra.qualcomm.net` not connected |
| TTS silent or robotic | Kokoro model files missing — run `git lfs pull` or download manually |
| Frontend stale after edit | Hard-refresh the tab (`Ctrl+Shift+R`) — JS is served raw, not built |
| Port 5000 already in use | `run.ps1` kills it automatically; otherwise `Get-NetTCPConnection -LocalPort 5000` |

---

## Documentation

- [`CODEBASE_STATE.md`](CODEBASE_STATE.md) — ground-truth architecture, agent inventory,
  API contracts, fallback chains, completed/remaining feature list.
- [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) — prioritised roadmap with effort
  estimates and risks.
- [`CabinAI_Hybrid_Orchestration_Deep_Dive.pdf`](CabinAI_Hybrid_Orchestration_Deep_Dive.pdf)
  — design narrative for the orchestration layer.

---

