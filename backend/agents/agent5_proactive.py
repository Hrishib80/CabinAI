"""
Agent 5 — Proactive Intelligence.
Model: configurable via MODEL_AGENT5 (default Qwen3-VL-32B) on QAIC Inference Gateway.
Uses OpenAI Python SDK pointed at the QAIC gateway (fully OpenAI-compatible).
Fires every 5 min; receives <32 KB session buffer; returns fatigue forecast + enriched context.
Falls back to QGenie (anthropic::claude-4-5-sonnet) when CLOUD_LLM_ENABLED=true and AIC100 fails.
Supports VLM image frame (latest_frame_b64) for true visual analysis.
Recommended rest stop is **picked dynamically from the simulator's current location** so it
always matches the Hyderabad route (no more "Innsbruck Nord").
"""
import json, time
from backend.config import (
    HYDRA_BASE_URL, APIGEE_TOKEN, QAIC_API_KEY,
    MODEL_AGENT5, AIC100_TIMEOUT_S, MAX_PAYLOAD_BYTES,
    CLOUD_LLM_ENABLED, CLOUD_LLM_API_KEY, CLOUD_LLM_ENDPOINT, CLOUD_LLM_MODEL,
)

# Hyderabad rest-stop catalogue keyed by upstream segment names (matches frontend HYDERABAD_ROUTE).
# When picking a rest stop we look at the *current* game_location and choose the nearest
# downstream rest/parking/gas/emergency segment, with a humanised distance.
HYDERABAD_ROUTE = [
    ("Gachibowli Stadium",          "parking",   30),   # 0
    ("Gachibowli Main Road",        "urban",     60),   # 1
    ("Mindspace Junction",          "urban",     50),   # 2
    ("DLF Cyber City",              "urban",     50),   # 3
    ("DLF Fuel Station",            "gas",       25),   # 4
    ("Financial District",          "urban",     50),   # 5
    ("Durgam Cheruvu Tunnel",       "tunnel",    50),   # 6
    ("Nanakramguda Junction",       "highway",   80),   # 7
    ("Biodiversity Junction",       "rest",      30),   # 8
    ("IKEA Hyderabad, Nallagandla", "parking",   25),   # 9
    ("Nallagandla Township",        "urban",     50),   # 10
    ("Hi-Tech City",                "urban",     50),   # 11
    ("Madhapur Flyover",            "highway",   80),   # 12
    ("ORR Toll Plaza",              "highway",   100),  # 13
    ("ORR Emergency Bay",           "emergency", 30),   # 14
    ("ORR Highway",                 "highway",   120),  # 15
    ("Shamshabad Airport",          "parking",   30),   # 16
]
SEG_LENGTH_KM = 0.4   # 400 m per segment, matches the frontend


def pick_rest_stop(current_location: str | None) -> tuple[str, float]:
    """
    Return (rest_stop_label, distance_km) chosen dynamically from the Hyderabad route.
    Picks the nearest *forward* rest/parking/gas/emergency segment relative to the
    driver's current segment.  Falls back to 'Biodiversity Junction' if location unknown.
    """
    rest_kinds = {"rest", "parking", "gas", "emergency"}
    cur_idx = 0
    if current_location:
        for i, (name, _t, _s) in enumerate(HYDERABAD_ROUTE):
            if current_location.lower() in name.lower() or name.lower() in current_location.lower():
                cur_idx = i
                break
    # Search forward
    for offset in range(1, len(HYDERABAD_ROUTE) + 1):
        i = (cur_idx + offset) % len(HYDERABAD_ROUTE)
        name, t, _s = HYDERABAD_ROUTE[i]
        if t in rest_kinds:
            return name, round(offset * SEG_LENGTH_KM, 1)
    return "Biodiversity Junction", 3.2


AGENT5_PROMPT = """You are a driver fatigue analysis AI with access to a 5-minute session of biometric data
for a vehicle currently driving in Gachibowli, Hyderabad on a route through DLF Cyber City, the Durgam
Cheruvu Tunnel, Hi-Tech City, ORR Highway and Shamshabad Airport.

SESSION DATA:
{session_json}

CURRENT VEHICLE LOCATION: {current_location}
NEAREST REST STOP: {nearest_rest} (~{rest_km} km ahead)

Analyse the temporal trends in EAR (eye aspect ratio), perclos, blink frequency, and head pose drift.
EAR below 0.20 = eye closure. Perclos = % eye-closed frames over 60s. Blink freq normal = 12-20/min.

Use the *Hyderabad-specific* nearest rest stop above (do NOT mention German or other foreign place
names). Examples of valid rest stops: Biodiversity Junction, IKEA Nallagandla, Gachibowli Stadium,
ORR Emergency Bay, DLF Fuel Station, Shamshabad Airport.

Return ONLY valid JSON matching this exact schema (no markdown, no explanation):
{{
  "fatigue_forecast": <float 0.0-1.0, probability driver fatigued in next 15 minutes>,
  "forecast_confidence": <float 0.0-1.0>,
  "enriched_system_prompt": {{
    "driver_fatigue_state": <float 0.0-1.0 current state>,
    "fatigue_forecast_t15": <float, same as fatigue_forecast>,
    "recommended_rest": "<one of the Hyderabad rest stops, with km distance>",
    "route_complexity": "<low|medium|high_curvature>",
    "driver_profile": {{"typical_onset_min": <int>, "alert_style": "<gentle|firm>"}}
  }},
  "proactive_alert": {{
    "msg": "<alert message if forecast > 0.75 (mention the Hyderabad rest stop name), else null>",
    "urgency": "<advisory|warning|critical>"
  }},
  "hardware_health": {{
    "status": "<nominal|degrading|critical>",
    "predicted_failure_days": <int or null>,
    "model_swap_recommendation": "<model_name or null>"
  }}
}}"""


def _build_mock(current_location: str | None) -> dict:
    rest_name, rest_km = pick_rest_stop(current_location)
    return {
        "fatigue_forecast": 0.62,
        "forecast_confidence": 0.74,
        "enriched_system_prompt": {
            "driver_fatigue_state": 0.45,
            "fatigue_forecast_t15": 0.62,
            "recommended_rest": f"{rest_name}, {rest_km}km",
            "route_complexity": "medium",
            "driver_profile": {"typical_onset_min": 68, "alert_style": "gentle"},
        },
        "proactive_alert": {
            "msg": f"Fatigue rising — consider a break at {rest_name} (~{rest_km}km).",
            "urgency": "advisory",
        },
        "hardware_health": {
            "status": "nominal",
            "predicted_failure_days": None,
            "model_swap_recommendation": None,
        },
    }


# Back-compat: callers that still reference MOCK_RESPONSE get a Hyderabad default.
MOCK_RESPONSE = _build_mock(None)


def _get_client():
    import httpx
    from openai import OpenAI
    return OpenAI(
        base_url=HYDRA_BASE_URL,
        api_key=QAIC_API_KEY,
        default_headers={"x-apikey": APIGEE_TOKEN},
        timeout=AIC100_TIMEOUT_S,
        http_client=httpx.Client(verify=False),
    )


def _get_cloud_llm_client():
    import httpx
    from openai import OpenAI
    return OpenAI(
        base_url=CLOUD_LLM_ENDPOINT,
        api_key=CLOUD_LLM_API_KEY,
        timeout=AIC100_TIMEOUT_S,
        http_client=httpx.Client(verify=False),
    )


def _build_messages(payload: dict, frame_b64: str | None) -> list:
    current_location = payload.get("game_location") or payload.get("current_location") or "Gachibowli"
    rest_name, rest_km = pick_rest_stop(current_location)
    session_text = json.dumps({k: v for k, v in payload.items() if k != "latest_frame_b64"}, indent=2)
    prompt_text  = AGENT5_PROMPT.format(
        session_json=session_text,
        current_location=current_location,
        nearest_rest=rest_name,
        rest_km=rest_km,
    )

    if frame_b64:
        return [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{frame_b64}"}},
                {"type": "text", "text": prompt_text},
            ],
        }]
    return [{"role": "user", "content": prompt_text}]


def _call_llm(client, model: str, messages: list, max_tokens: int, temperature: float) -> str:
    response = client.chat.completions.create(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
        temperature=temperature,
    )
    return response.choices[0].message.content


def _parse_response(content: str, fallback: dict, latency_ms: float) -> tuple[dict, float]:
    if "```" in content:
        content = content.split("```")[1]
        if content.startswith("json"):
            content = content[4:]
    try:
        return json.loads(content.strip()), latency_ms
    except Exception:
        return fallback, latency_ms


def run_sync(payload: dict, use_mock: bool = False) -> tuple[dict, float]:
    """
    Returns (result_dict, latency_ms).
    Falls back to QGenie then mock if AIC100 unavailable.
    Supports payload["latest_frame_b64"] for VLM visual analysis.
    """
    frame_b64 = payload.pop("latest_frame_b64", None)

    if use_mock or not QAIC_API_KEY:
        # use_mock always returns mock — don't call any LLM with test/fake frames
        if use_mock:
            time.sleep(0.2)
            return MOCK_RESPONSE, 200.0
        if CLOUD_LLM_ENABLED and CLOUD_LLM_API_KEY:
            return _run_with_client(_get_cloud_llm_client(), CLOUD_LLM_MODEL, payload, frame_b64)
        time.sleep(0.5)
        return MOCK_RESPONSE, 500.0

    payload_bytes = len(json.dumps(payload).encode())
    if payload_bytes > MAX_PAYLOAD_BYTES:
        raise ValueError(f"Payload {payload_bytes} bytes exceeds 32 KB gateway limit")

    messages = _build_messages(payload, frame_b64)

    t0 = time.perf_counter()
    try:
        client  = _get_client()
        content = _call_llm(client, MODEL_AGENT5, messages, max_tokens=600, temperature=0.1)
    except Exception as aic100_err:
        if CLOUD_LLM_ENABLED and CLOUD_LLM_API_KEY:
            print(f"[Agent5] AIC100 error ({aic100_err}), falling back to QGenie")
            return _run_with_client(_get_cloud_llm_client(), CLOUD_LLM_MODEL, payload, frame_b64)
        time.sleep(0.2)
        return MOCK_RESPONSE, round((time.perf_counter() - t0) * 1000)

    latency_ms = (time.perf_counter() - t0) * 1000
    return _parse_response(content, MOCK_RESPONSE, latency_ms)


def _run_with_client(client, model: str, payload: dict, frame_b64: str | None = None) -> tuple[dict, float]:
    messages   = _build_messages(payload, frame_b64)
    t0         = time.perf_counter()
    content    = _call_llm(client, model, messages, max_tokens=600, temperature=0.1)
    latency_ms = (time.perf_counter() - t0) * 1000
    return _parse_response(content, MOCK_RESPONSE, latency_ms)
