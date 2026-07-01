"""
CabinAI Flask backend.
Endpoints:
  POST /api/buffer/frame        — ingest one frame from Agent 1 (frontend)
  POST /api/agent3/transcribe   — STT: AIC100 Whisper → Distil-Whisper local → Web Speech fallback
  POST /api/agent5/sync         — run proactive sync (Agent 5, AIC100) — supports latest_frame_b64
  POST /api/agent6/query        — run complex voice query (Agent 6, AIC100)
  POST /api/agent6/coaching     — generate post-trip coaching
  POST /api/agent7/query        — run local RAG query (Agent 7)
  POST /api/agent4/generate     — SSE streaming for edge LLM (Agent 4)
  POST /api/state/update        — frontend pushes perception metrics
  GET  /api/state               — return current ZeroClaw bus state
  GET  /api/events              — SSE stream of all bus events
  GET  /api/health              — ping
  POST /api/tts/speak           — TTS: AIC100 MeloTTS-EN → Kokoro-ONNX local → pyttsx3
  POST /api/fleet/update        — fleet vehicle telemetry push
  GET  /api/fleet/state         — fleet state snapshot
  GET  /api/fleet/events        — fleet SSE stream
"""
import sys, os, json, time, queue, threading, warnings
warnings.filterwarnings("ignore", message=".*PyTorch.*")
warnings.filterwarnings("ignore", message=".*torch.*")
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS

from backend.config import (
    FLASK_PORT, FLASK_DEBUG, AGENT4_BACKEND, OLLAMA_BASE_URL, OLLAMA_MODEL,
    LOCAL_WHISPER_ENABLED, LOCAL_TTS_ENABLED, LOCAL_TTS_VOICE, STT_LANGUAGE,
)
from backend.orchestrator.zeroclaw_bus import bus
from backend.orchestrator.query_router import route_query, extract_features
from backend.orchestrator.safety_floor import dispatch as _safety_dispatch
from backend.orchestrator.vote_fusion import classify as _vote_classify
from backend.orchestrator.npu_health import NPUHealthPredictor
from backend.agents.session_buffer import SessionBuffer
from backend.agents.agent5_proactive import run_sync
from backend.agents.agent6_complex import handle_complex_query, generate_coaching_report
from backend.agents.agent7_rag import get_rag, CONFIDENCE_THRESHOLD
from backend.audit_log import log_egress
from backend.phi_redactor import redact as _phi_redact

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

session_buffer = SessionBuffer()
_npu_predictor = NPUHealthPredictor()

# Pre-warm Agent 7 RAG + local models in background
def _prewarm_rag():
    try:
        get_rag()
        print("[CabinAI] Agent 7 RAG warmed up")
    except Exception as e:
        print(f"[CabinAI] Agent 7 RAG warmup failed (keyword fallback active): {e}")

threading.Thread(target=_prewarm_rag, daemon=True).start()

if LOCAL_WHISPER_ENABLED:
    from backend.agents.local_whisper import warm_up as _whisper_warmup
    _whisper_warmup()

if LOCAL_TTS_ENABLED:
    from backend.agents.local_tts import warm_up as _tts_warmup
    _tts_warmup()


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "ts": time.time()})


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------
@app.get("/api/state")
def get_state():
    return jsonify(bus.get_state())


@app.post("/api/state/update")
def update_state():
    """Frontend pushes Agent 1 perception metrics OR game state each frame."""
    data = request.get_json(force=True)
    # Auto-detect: GAME_STATE has 'game_speed', PERCEPTION has attention/drowsiness
    if isinstance(data, dict) and ("game_speed" in data or "game_location" in data):
        bus.publish("GAME_STATE", data)
        # Publish per-game bus events so frontend game subscribers receive them via SSE
        if "game_action" in data:
            action = data["game_action"]
            if action == "GAME_JUMP" and data.get("idx") is not None:
                bus.publish("GAME_JUMP_REQUEST", {"idx": data["idx"]})
            elif action == "GAME_SPEED" and data.get("delta") is not None:
                bus.publish("GAME_SPEED_REQUEST", {"delta": data["delta"]})
            elif action == "GAME_WEATHER" and data.get("weather"):
                bus.publish("GAME_WEATHER_REQUEST", {"weather": data["weather"]})
            elif action == "GAME_TOGGLE":
                bus.publish("GAME_TOGGLE_REQUEST", {})
    else:
        bus.publish("PERCEPTION_UPDATE", data)
        if "landmarks" in data:
            session_buffer.maybe_sample(data["landmarks"], data)
        # Vote fusion: compute consensus level after drowsiness update
        rule_v = bus.state.get('drowsiness_score', 0) > 0.7
        ml_v   = float(bus.state.get('drowsiness_score', 0))
        llm_v  = None
        level  = _vote_classify(rule_v, ml_v, llm_v)
        bus.state['alert_consensus_level'] = level
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Agent 3 — Speech-to-Text
# Fallback chain:
#   1. AIC100 openai/whisper-large-v3-turbo (primary, best quality)
#   2. Local Distil-Whisper via transformers (offline, ~2-5s on CPU)
#   3. QGenie claude-4-5-sonnet (if CLOUD_LLM_ENABLED — stub for testing)
#   4. Mock transcript
# ---------------------------------------------------------------------------
@app.post("/api/agent3/transcribe")
def agent3_transcribe():
    """
    Accepts multipart/form-data with a 'file' field (webm/opus from MediaRecorder).
    """
    from backend.config import (
        HYDRA_BASE_URL, APIGEE_TOKEN, QAIC_API_KEY, MODEL_STT,
        CLOUD_LLM_ENABLED, CLOUD_LLM_API_KEY, CLOUD_LLM_ENDPOINT, CLOUD_LLM_MODEL,
        LOCAL_WHISPER_ENABLED,
    )
    import tempfile, os as _os

    if "file" not in request.files:
        return jsonify({"error": "no file field"}), 400

    audio_file  = request.files["file"]
    audio_bytes = audio_file.read()

    # Language for STT (en/hi/te) — falls back to STT_LANGUAGE config default
    lang = request.form.get("language") or STT_LANGUAGE or "en"

    if len(audio_bytes) < 500:
        return jsonify({"error": "audio too short"}), 400

    t0 = time.perf_counter()

    # ── Primary: AIC100 Whisper ──────────────────────────────────
    if QAIC_API_KEY:
        suffix = ".webm"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name
        try:
            from openai import OpenAI
            import httpx
            client = OpenAI(
                base_url=HYDRA_BASE_URL,
                api_key=QAIC_API_KEY,
                default_headers={"x-apikey": APIGEE_TOKEN},
                timeout=60,
                http_client=httpx.Client(verify=False),
            )
            log_egress(stage='transcribe', target='AIC100', n_chars=len(audio_bytes), redacted=False)
            with open(tmp_path, "rb") as f:
                result = client.audio.transcriptions.create(
                    model=MODEL_STT, file=f, language=lang, response_format="json",
                )
            latency_ms = round((time.perf_counter() - t0) * 1000)
            text = (result.text or "").strip()
            bus.publish("SESSION_EVENT", {
                "type": "stt_result", "query": text[:60],
                "latency_ms": latency_ms, "source": "aic100", "ts": time.time(),
            })
            sf_result = _safety_dispatch(text)
            if sf_result is not None:
                bus.publish('SAFETY_FLOOR_HIT', sf_result)
                return jsonify({'safety_floor': True, 'action': sf_result['action'],
                                'label': sf_result['label'], 'latency_ms': sf_result['latency_ms']})
            return jsonify({"text": text, "latency_ms": latency_ms, "source": "aic100"})
        except Exception as e:
            err_str = str(e)
            print(f"[Agent3] AIC100 error: {err_str[:120]}")
            if "429" in err_str or "rate_limit" in err_str.lower():
                print("[Agent3] Rate limited — falling through to local Distil-Whisper")
        finally:
            try: _os.unlink(tmp_path)
            except Exception: pass

    # ── Fallback 1: Local Distil-Whisper (always available) ──────
    if LOCAL_WHISPER_ENABLED:
        try:
            from backend.agents.local_whisper import transcribe_bytes
            text, latency_ms = transcribe_bytes(audio_bytes, language=lang)
            if text:
                bus.publish("SESSION_EVENT", {
                    "type": "stt_result", "query": text[:60],
                    "latency_ms": latency_ms, "source": "local_whisper", "ts": time.time(),
                })
                sf_result = _safety_dispatch(text)
                if sf_result is not None:
                    bus.publish('SAFETY_FLOOR_HIT', sf_result)
                    return jsonify({'safety_floor': True, 'action': sf_result['action'],
                                    'label': sf_result['label'], 'latency_ms': sf_result['latency_ms']})
                return jsonify({"text": text, "latency_ms": latency_ms, "source": "local_distil_whisper"})
        except Exception as e:
            print(f"[Agent3] Local Whisper error: {e}")

    # ── Fallback 2: honest failure → browser Web Speech API takes over ──
    # NOTE: we deliberately do NOT ask an LLM to "guess" a command here. Doing so
    # fabricates a transcript unrelated to what the user said (e.g. always
    # "turn on the AC"), which is worse than failing. Returning an error lets the
    # frontend fall back to the browser's built-in Web Speech API.
    print("[Agent3] AIC100 + local Distil-Whisper both unavailable — "
          "returning error so browser Web Speech API handles STT")
    return jsonify({
        "error": "stt_unavailable",
        "detail": "AIC100 and local Distil-Whisper both failed; "
                  "use browser Web Speech API",
        "source": "none",
    }), 503


# ---------------------------------------------------------------------------
# Session buffer
# ---------------------------------------------------------------------------
@app.post("/api/buffer/frame")
def buffer_frame():
    data = request.get_json(force=True)
    session_buffer.ingest_from_frontend(data)
    return jsonify({"frames": len(session_buffer.frames),
                    "size_bytes": session_buffer.payload_size_bytes()})


# ---------------------------------------------------------------------------
# Agent 5 — Proactive Sync
# ---------------------------------------------------------------------------
@app.post("/api/agent5/sync")
def agent5_sync():
    payload = session_buffer.to_sync_payload()
    # Inject the live driving simulator location so Agent 5 can pick a Hyderabad rest stop.
    state = bus.get_state()
    payload["game_location"]     = state.get("game_location", "Gachibowli")
    payload["game_segment_type"] = state.get("game_segment_type", "parking")
    payload["game_speed"]        = state.get("game_speed", 0.0)
    payload["game_distance_km"]  = state.get("game_distance_km", 0.0)
    use_mock = request.args.get("mock", "false").lower() == "true"

    payload_json = json.dumps({k: v for k, v in payload.items() if k != "latest_frame_b64"})
    text_clean, was_redacted = _phi_redact(payload_json)
    log_egress(stage='agent5_sync', target='AIC100', n_chars=len(text_clean), redacted=was_redacted)

    try:
        result, latency_ms = run_sync(payload, use_mock=use_mock)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    # ── Gate the proactive fatigue alert on the REAL on-device drowsiness ──
    # The LLM is free to narrate, but it must not raise (or invent the numbers
    # for) a fatigue alarm when the device's own measurements are fine. We trust
    # the deterministic Agent-1 drowsiness series, not the LLM's claim.
    ds_series = payload.get("attention_scores", [])  # these are drowsiness_score values
    recent = ds_series[-30:] if ds_series else []
    real_drowsiness = (sum(recent) / len(recent)) if recent else 0.0
    real_attention = max(0.0, 1.0 - real_drowsiness * 1.2)
    DROWSY_ALERT_THRESHOLD = 0.7

    alert = result.get("proactive_alert") or {}
    if real_drowsiness < DROWSY_ALERT_THRESHOLD:
        # No real drowsiness → suppress any alarm the LLM tried to raise.
        if alert.get("msg"):
            print(f"[Agent5] suppressing LLM fatigue alert "
                  f"(real drowsiness {real_drowsiness:.2f} < {DROWSY_ALERT_THRESHOLD})")
        result["proactive_alert"] = {"msg": None, "urgency": "advisory"}
    else:
        # Real drowsiness IS high → keep the alert but stamp the TRUE number so
        # the displayed score can't be a hallucination.
        rest = (result.get("enriched_system_prompt", {}) or {}).get("recommended_rest", "a rest stop")
        result["proactive_alert"] = {
            "msg": (f"FATIGUE WARNING: drowsiness {real_drowsiness:.2f} "
                    f"(attention {real_attention:.2f}). Consider a break at {rest}."),
            "urgency": "critical" if real_drowsiness > 0.85 else "warning",
        }
    # Always expose the real measured numbers alongside the forecast.
    result["measured_drowsiness"] = round(real_drowsiness, 4)
    result["measured_attention"] = round(real_attention, 4)

    bus.publish("FATIGUE_FORECAST", result)
    bus.publish("SESSION_EVENT", {
        "type": "agent5_sync",
        "fatigue_forecast": result.get("fatigue_forecast"),
        "latency_ms": round(latency_ms, 1),
        "ts": time.time(),
    })

    return jsonify({**result, "latency_ms": round(latency_ms, 1)})


# ---------------------------------------------------------------------------
# Agent 6 — Complex Query + Coaching
# ---------------------------------------------------------------------------
@app.post("/api/agent6/query")
def agent6_query():
    body = request.get_json(force=True)
    query   = body.get("query", "")
    context = body.get("context", bus.get_state())
    use_mock = body.get("mock", False)

    if not query:
        return jsonify({"error": "query is required"}), 400

    text_clean, was_redacted = _phi_redact(query)
    log_egress(stage='agent6_query', target='AIC100', n_chars=len(text_clean), redacted=was_redacted)

    try:
        response, latency_ms = handle_complex_query(text_clean, context, use_mock=use_mock)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    bus.publish("SESSION_EVENT", {"type": "agent6_query", "query": text_clean[:50],
                                   "latency_ms": round(latency_ms, 1), "ts": time.time()})
    return jsonify({"response": response, "latency_ms": round(latency_ms, 1),
                    "agent": "Agent6", "model": "Qwen3-30B"})


@app.post("/api/agent6/coaching")
def agent6_coaching():
    body = request.get_json(force=True)
    session_log = body.get("session_log", {"events": bus.get_state().get("session_events", [])})
    use_mock = body.get("mock", False)

    try:
        report, latency_ms = generate_coaching_report(session_log, use_mock=use_mock)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    if "driver_profile_update" in report:
        bus.publish("SESSION_EVENT", {"type": "coaching_complete",
                                       "latency_ms": round(latency_ms, 1), "ts": time.time()})
    return jsonify({**report, "latency_ms": round(latency_ms, 1)})


# ---------------------------------------------------------------------------
# Agent 7 — Local RAG
# ---------------------------------------------------------------------------
@app.post("/api/agent7/query")
def agent7_query():
    body  = request.get_json(force=True)
    question = body.get("question", "")
    if not question:
        return jsonify({"error": "question is required"}), 400

    rag = get_rag()
    chunks, confidence, latency_ms = rag.query(question)

    if confidence >= CONFIDENCE_THRESHOLD:
        return jsonify({
            "source": "local",
            "chunks": chunks,
            "confidence": round(confidence, 3),
            "latency_ms": round(latency_ms, 1),
            "escalate": False,
        })
    else:
        # Escalate: call Agent 6 and cache result
        use_mock = body.get("mock", False)
        context = {**bus.get_state(), "local_chunks": chunks, "local_confidence": confidence}
        try:
            cloud_answer, cloud_latency = handle_complex_query(question, context, use_mock=use_mock)
            rag.add_cached_response(question, cloud_answer)
        except Exception as e:
            cloud_answer = f"[Agent 6 error: {e}]"
            cloud_latency = 0.0

        return jsonify({
            "source": "cloud",
            "chunks": chunks,
            "confidence": round(confidence, 3),
            "local_latency_ms": round(latency_ms, 1),
            "cloud_answer": cloud_answer,
            "cloud_latency_ms": round(cloud_latency, 1),
            "escalate": True,
        })


# ---------------------------------------------------------------------------
# Agent 4 — Edge LLM streaming (SSE)
# Fallback chain: Ollama → QGenie (claude-4-5-sonnet) → informative mock
# ---------------------------------------------------------------------------
import datetime as _dt

def _build_agent4_system(state: dict, rag_context: str = "") -> str:
    now = _dt.datetime.now().strftime("%I:%M %p, %A %B %d %Y")
    fatigue = state.get("driver_fatigue_state", 0)
    forecast = state.get("fatigue_forecast_t15", 0)
    rest = state.get("recommended_rest", "") or "none"
    drowsy = state.get("drowsiness_score", 0)
    attention = state.get("attention_score", 1)
    speed = state.get("game_speed", 0)
    location = state.get("game_location", "Gachibowli")
    engine_temp = state.get("game_engine_temp", 0.35)
    fuel_level = state.get("game_fuel", 1.0)

    rag_block = ""
    if rag_context:
        rag_block = (
            f"\n\nRELEVANT KNOWLEDGE (from local Hyderabad RAG corpus — use this to answer):\n"
            f"{rag_context}\n"
        )

    sim_block = ""
    if speed or location != "Gachibowli":
        sim_block = (
            f"\nLIVE DRIVE STATE — Location: {location}, Speed: {speed:.0f} km/h, "
            f"Engine temp: {engine_temp:.0%}, Fuel: {fuel_level:.0%}."
        )

    # Location-aware RAG: inject context specific to the current game location
    location_block = ""
    game_loc = (state or {}).get('game_location', '')
    if game_loc:
        try:
            loc_chunks, loc_confidence, _ = get_rag().query(game_loc, top_k=1)
            if loc_confidence > 0.4 and loc_chunks:
                location_context = loc_chunks[0][:300]
                location_block = (
                    f"\nCURRENT LOCATION CONTEXT (for {game_loc}):\n{location_context}\n"
                )
        except Exception:
            pass

    return (
        f"You are CabinAI, a natural, friendly in-vehicle AI co-pilot driving in Gachibowli, "
        f"Hyderabad (Telangana, India). "
        f"Current time: {now}. "
        f"Driver status — attention: {attention:.2f}, drowsiness: {drowsy:.2f}, "
        f"fatigue forecast T+15min: {forecast:.0%}. "
        f"Recommended rest stop: {rest}."
        f"{sim_block}"
        f"{location_block}"
        f"{rag_block}\n"
        f"CRITICAL RULES:\n"
        f"1. Answer the question DIRECTLY — never say 'Understood', 'Processing your request', "
        f"'Let me check', 'One moment', or any filler. Just give the answer.\n"
        f"2. Keep responses to 1-3 short sentences. Be conversational and natural.\n"
        f"3. Use Hyderabad/Gachibowli landmarks (DLF Cyber City, Hi-Tech City, ORR, Biodiversity Junction, "
        f"Durgam Cheruvu, KIMS Hospital, Shamshabad Airport).\n"
        f"4. Answer general questions (time, weather, facts) directly and confidently.\n"
        f"5. For vehicle commands ONLY, respond with JSON: "
        '{{"function":"play_media","query":"..."}} or {{"function":"navigate_to","destination":"..."}} or {{"function":"set_volume","level":5}}.\n'
        f"6. If the driver seems drowsy (drowsiness > 0.6), gently suggest a break at a nearby rest area "
        f"like Biodiversity Junction or IKEA Nallagandla."
    )


@app.post("/api/agent4/generate")
def agent4_generate():
    body  = request.get_json(force=True)
    query = body.get("query", "")
    state = bus.get_state()

    # Pull top-k RAG chunks so Agent 4 can answer Hyderabad/vehicle questions confidently
    rag_context = ""
    try:
        rag = get_rag()
        chunks, confidence, _ = rag.query(query, top_k=2)
        if confidence > 0.30 and chunks:
            rag_context = "\n---\n".join(c.strip() for c in chunks[:2])
    except Exception as _e:
        pass

    system = _build_agent4_system(state, rag_context)

    def generate():
        from backend.config import CLOUD_LLM_ENABLED, CLOUD_LLM_API_KEY, CLOUD_LLM_ENDPOINT, CLOUD_LLM_MODEL

        # Primary: QGenie (claude-4-5-sonnet streaming) — preferred over Ollama
        if CLOUD_LLM_ENABLED and CLOUD_LLM_API_KEY:
            yield from _stream_cloud_llm(query, system, CLOUD_LLM_ENDPOINT, CLOUD_LLM_API_KEY, CLOUD_LLM_MODEL)
            return

        # Fallback 1: Ollama (local)
        if AGENT4_BACKEND == "ollama":
            got_response = False
            for chunk in _stream_ollama(query, system):
                got_response = True
                yield chunk
            if got_response:
                return

        # Fallback 2: AIC100 Agent6 (non-streaming, wrapped as SSE)
        try:
            from backend.agents.agent6_complex import handle_complex_query
            response, _ = handle_complex_query(query, state, use_mock=False)
            for word in response.split():
                yield f"data: {json.dumps({'token': word + ' '})}\n\n"
            yield f"data: {json.dumps({'done': True})}\n\n"
            return
        except Exception:
            pass

        # Fallback 3: Smart mock (answers common questions)
        yield from _smart_mock(query, state)

    return Response(stream_with_context(generate()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _stream_ollama(query: str, system: str):
    """
    Stream from Ollama. Buffers the first few tokens to detect filler responses
    (e.g. "Understood. Processing your request.") — if filler is detected, yields
    NOTHING so the caller falls through to QGenie.
    """
    import requests as _req
    FILLER = ['understood', 'processing your request', 'let me check',
              'one moment', 'i will', "i'll look", 'certainly', 'sure thing']
    try:
        resp = _req.post(
            f"{OLLAMA_BASE_URL}/api/chat",
            json={"model": OLLAMA_MODEL, "stream": True,
                  "messages": [{"role": "system", "content": system},
                                {"role": "user",   "content": query}],
                  "options": {"num_predict": 200}},
            stream=True, timeout=(2, 20),
        )
        if resp.status_code != 200:
            return
        last_token_ts = time.time()
        buffer = []
        flushed = False
        for line in resp.iter_lines(decode_unicode=False):
            if time.time() - last_token_ts > 4:
                print("[Agent4/Ollama] Stalled — aborting")
                resp.close()
                if not flushed:
                    return  # never yielded → caller tries QGenie
                return
            if not line:
                continue
            try:
                chunk = json.loads(line)
            except Exception:
                continue
            token = chunk.get("message", {}).get("content", "")
            if token:
                last_token_ts = time.time()
                if not flushed:
                    buffer.append(token)
                    joined = ''.join(buffer).lower().strip()
                    if len(buffer) >= 8 or chunk.get("done"):
                        if any(f in joined for f in FILLER) or len(joined) < 3:
                            print(f"[Agent4/Ollama] Filler detected: '{joined[:60]}' — skipping")
                            resp.close()
                            return  # yields nothing → caller tries QGenie
                        flushed = True
                        for t in buffer:
                            yield f"data: {json.dumps({'token': t})}\n\n"
                else:
                    yield f"data: {json.dumps({'token': token})}\n\n"
            if chunk.get("done"):
                if not flushed and buffer:
                    joined = ''.join(buffer).lower().strip()
                    if any(f in joined for f in FILLER):
                        print(f"[Agent4/Ollama] Filler in final: '{joined[:60]}' — skipping")
                        return
                    for t in buffer:
                        yield f"data: {json.dumps({'token': t})}\n\n"
                yield f"data: {json.dumps({'done': True})}\n\n"
                return
    except Exception as e:
        print(f"[Agent4/Ollama] error: {e}")
        return


def _get_httpx_client():
    """Return an httpx client with SSL verification disabled for corporate proxy."""
    import httpx
    return httpx.Client(verify=False)


def _stream_cloud_llm(query: str, system: str, endpoint: str, api_key: str, model: str):
    FILLER = ['understood', 'processing your request', 'let me check',
              'one moment', 'i will', "i'll look", 'certainly', 'sure thing',
              'i understand', 'got it']
    try:
        from openai import OpenAI
        client = OpenAI(base_url=endpoint, api_key=api_key, timeout=20,
                        http_client=_get_httpx_client())
        stream = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system},
                      {"role": "user",   "content": query}],
            stream=True,
            max_tokens=250,
            temperature=0.5,
        )
        last_token_ts = time.time()
        buffer = []
        flushed = False
        for chunk in stream:
            if time.time() - last_token_ts > 8:
                print("[Agent4/QGenie] Stalled — closing stream")
                break
            token = chunk.choices[0].delta.content or ""
            if token:
                last_token_ts = time.time()
                if not flushed:
                    buffer.append(token)
                    if len(buffer) >= 6:
                        joined = ''.join(buffer).lower().strip()
                        if any(f in joined for f in FILLER):
                            print(f"[Agent4/QGenie] Filler: '{joined[:60]}' — using smart mock")
                            yield from _smart_mock(query, {})
                            return
                        flushed = True
                        for t in buffer:
                            yield f"data: {json.dumps({'token': t})}\n\n"
                else:
                    yield f"data: {json.dumps({'token': token})}\n\n"
        # Flush remaining buffer
        if not flushed and buffer:
            joined = ''.join(buffer).lower().strip()
            if any(f in joined for f in FILLER):
                print(f"[Agent4/QGenie] Filler in final: '{joined[:60]}' — using smart mock")
                yield from _smart_mock(query, {})
                return
            for t in buffer:
                yield f"data: {json.dumps({'token': t})}\n\n"
        yield f"data: {json.dumps({'done': True})}\n\n"
        if not flushed and not buffer:
            print("[Agent4/QGenie] No tokens received")
    except Exception as e:
        print(f"[Agent4/QGenie] error: {e}")
        yield from _smart_mock(query, {})


def _smart_mock(query: str, state: dict):
    """Informative mock that answers common questions without an LLM."""
    q = query.lower()
    now = _dt.datetime.now()

    if any(w in q for w in ["time", "clock", "hour"]):
        response = f"It's {now.strftime('%I:%M %p')}."
    elif any(w in q for w in ["date", "day", "today"]):
        response = f"Today is {now.strftime('%A, %B %d %Y')}."
    elif any(w in q for w in ["what can you", "what do you", "help me", "capabilities", "what are you"]):
        response = ("I'm CabinAI, your in-vehicle AI co-pilot. I can monitor your alertness and warn you about drowsiness, "
                    "answer questions about your route through Gachibowli and the ORR, play music, navigate to rest stops, "
                    "explain dashboard warning lights, and provide real-time driving advice. Just ask me anything!")
    elif any(w in q for w in ["jazz", "music", "play", "song"]):
        response = '{"function":"play_media","query":"jazz"}'
    elif any(w in q for w in ["volume", "louder", "quieter", "mute"]):
        response = '{"function":"set_volume","level":5}'
    elif any(w in q for w in ["navigate", "direction", "rest stop", "break", "petrol", "fuel"]):
        response = '{"function":"navigate_to","destination":"nearest rest stop near Gachibowli"}'
    elif any(w in q for w in ["tired", "sleepy", "drowsy", "fatigue"]):
        rest = state.get("recommended_rest", "Biodiversity Junction rest area")
        response = f"I can see you're getting tired. I recommend taking a break at {rest}. Your safety is the priority."
    elif any(w in q for w in ["hello", "hi", "hey"]):
        response = "Hello! I'm CabinAI, your driving assistant. I'm here to help keep you safe and comfortable. What do you need?"
    elif any(w in q for w in ["weather", "rain", "hot", "temperature"]):
        response = "Current conditions in Hyderabad: 34°C, partly cloudy. Visibility is good on the ORR. No rain expected today."
    else:
        response = f"I heard you say: '{query}'. I'm currently operating in offline mode without a language model. For best results, ensure your internet connection is active."

    for word in response.split():
        time.sleep(0.03)
        yield f"data: {json.dumps({'token': word + ' '})}\n\n"
    yield f"data: {json.dumps({'done': True})}\n\n"


# ---------------------------------------------------------------------------
# SSE event stream — all bus events forwarded to browser
# ---------------------------------------------------------------------------
@app.get("/api/events")
def sse_events():
    q = queue.Queue(maxsize=100)
    bus.add_sse_client(q)

    def stream():
        yield "data: {\"event\": \"connected\"}\n\n"
        try:
            while True:
                try:
                    msg = q.get(timeout=25)
                    yield f"data: {msg}\n\n"
                except queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            bus.remove_sse_client(q)

    return Response(stream_with_context(stream()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------------------
# Background sync ticker (decrements next_sync_in_s every second)
# ---------------------------------------------------------------------------
def _sync_ticker():
    while True:
        time.sleep(1)
        bus.publish("SYNC_TICK", {})
        state = bus.get_state()
        prediction = _npu_predictor.update(
            temp_c=state.get('npu_temp_c', 45.0),
            ber=state.get('npu_ber', 0.0),
            latency_dev_ms=state.get('npu_latency_dev_ms', 0.0),
        )
        bus.publish("NPU_PREDICTION", prediction)

threading.Thread(target=_sync_ticker, daemon=True).start()


# ---------------------------------------------------------------------------
# TTS — Text-to-Speech
# Fallback chain:
#   1. AIC100 MeloTTS-EN (if QAIC_API_KEY + VPN, best quality, 44.1 kHz)
#   2. Local Kokoro-ONNX (always available after first download, ~24 kHz)
#   3. pyttsx3 Windows SAPI (guaranteed, robotic)
# All paths return audio/wav so the browser plays it directly.
# Frontend falls back to speechSynthesis if this endpoint returns non-200.
# ---------------------------------------------------------------------------
@app.post("/api/tts/speak")
def tts_speak():
    from backend.config import HYDRA_BASE_URL, APIGEE_TOKEN, QAIC_API_KEY, LOCAL_TTS_ENABLED, LOCAL_TTS_VOICE
    from backend.agents.local_tts import get_voice_for_language
    body = request.get_json(force=True)
    text = (body.get("text") or "").strip()[:500]
    lang = (body.get("language") or STT_LANGUAGE or "en").lower()
    if not text:
        return jsonify({"error": "text required"}), 400

    # ── Primary: AIC100 MeloTTS-EN ────────────────────────────────
    if QAIC_API_KEY:
        try:
            import requests as _req
            text_clean, was_redacted = _phi_redact(text)
            log_egress(stage='tts', target='AIC100', n_chars=len(text_clean), redacted=was_redacted)
            resp = _req.post(
                f"{HYDRA_BASE_URL}/audio/speech",
                json={"model": "melotts-en", "input": text_clean, "voice": "default", "response_format": "wav"},
                headers={
                    "Authorization": f"Bearer {QAIC_API_KEY}",
                    "x-apikey": APIGEE_TOKEN,
                    "Content-Type": "application/json",
                },
                timeout=30,
            )
            if resp.ok:
                return Response(resp.content, mimetype="audio/wav",
                                headers={"Content-Disposition": "inline"})
            print(f"[TTS] AIC100 returned {resp.status_code}, falling back to local")
        except Exception as e:
            print(f"[TTS] AIC100 error: {e}, falling back to local")

    # ── Fallback: Local Kokoro-ONNX / pyttsx3 ────────────────────
    if LOCAL_TTS_ENABLED:
        try:
            from backend.agents.local_tts import synthesize
            tts_voice = get_voice_for_language(lang)
            wav_bytes, latency_ms = synthesize(text, voice=tts_voice)
            if wav_bytes:
                print(f"[TTS] Local Kokoro ({lang}/{tts_voice}): {latency_ms}ms for {len(text)} chars")
                return Response(wav_bytes, mimetype="audio/wav",
                                headers={"Content-Disposition": "inline",
                                         "X-TTS-Source": "kokoro-local",
                                         "X-TTS-Latency-Ms": str(latency_ms)})
        except Exception as e:
            print(f"[TTS] Local TTS error: {e}")

    return jsonify({"error": "all TTS paths failed", "fallback": True}), 503


# ---------------------------------------------------------------------------
# Fleet telemetry — multi-vehicle dashboard
# ---------------------------------------------------------------------------
_fleet_state: dict = {}
_fleet_sse_clients: list = []
_fleet_lock = threading.Lock()


@app.post("/api/fleet/update")
def fleet_update():
    """Vehicle pushes its telemetry: {"vehicle_id": "...", "metrics": {...}}"""
    body = request.get_json(force=True)
    vid  = body.get("vehicle_id", "unknown")
    with _fleet_lock:
        _fleet_state[vid] = {**body.get("metrics", {}), "ts": time.time(), "vehicle_id": vid}
    _push_fleet_sse({"event": "FLEET_UPDATE", "vehicle_id": vid,
                     "data": _fleet_state[vid], "ts": time.time()})
    return jsonify({"ok": True, "vehicles": len(_fleet_state)})


@app.get("/api/fleet/state")
def fleet_state():
    return jsonify({"vehicles": list(_fleet_state.values())})


@app.get("/api/fleet/events")
def fleet_events():
    q = queue.Queue(maxsize=100)
    with _fleet_lock:
        _fleet_sse_clients.append(q)

    def stream():
        yield f"data: {json.dumps({'event': 'connected', 'vehicles': len(_fleet_state)})}\n\n"
        try:
            while True:
                try:
                    msg = q.get(timeout=30)
                    yield f"data: {msg}\n\n"
                except queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            with _fleet_lock:
                if q in _fleet_sse_clients:
                    _fleet_sse_clients.remove(q)

    return Response(stream_with_context(stream()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _push_fleet_sse(msg: dict):
    dead = []
    for q in _fleet_sse_clients:
        try:
            q.put_nowait(json.dumps(msg))
        except Exception:
            dead.append(q)
    for d in dead:
        if d in _fleet_sse_clients:
            _fleet_sse_clients.remove(d)


# ---------------------------------------------------------------------------
# Agent 4 - Split Inference (Track 15)
# ---------------------------------------------------------------------------
@app.post("/api/agent4/generate_split")
def generate_split():
    body = request.get_json(force=True)
    query = body.get("query", "")
    result = _split_orchestrator.run(query, context="")
    return jsonify(result)


# ---------------------------------------------------------------------------
# FL Aggregator - status (Track 16)
# ---------------------------------------------------------------------------
@app.get("/api/fl/status")
def fl_status():
    return jsonify(_fl_aggregator.get_status())


# ---------------------------------------------------------------------------
# __init__ files
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print(f"[CabinAI] Backend starting on http://localhost:{FLASK_PORT}")
    print(f"[CabinAI] Agent4 backend: {AGENT4_BACKEND}")
    app.run(host="0.0.0.0", port=FLASK_PORT, debug=FLASK_DEBUG, threaded=True)
