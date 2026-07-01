"""
Agent 6 — Complex Query Handler + Post-Trip Coach.
Model: configurable via MODEL_AGENT6 (default Qwen3-8B) on QAIC Inference Gateway.
Uses OpenAI Python SDK pointed at the QAIC gateway (fully OpenAI-compatible).
Handles 20% of voice queries exceeding Agent 4 capability; generates post-trip coaching.
Falls back to QGenie (anthropic::claude-4-5-sonnet) when CLOUD_LLM_ENABLED=true and AIC100 fails.
"""
import json, time
from backend.config import (
    HYDRA_BASE_URL, APIGEE_TOKEN, QAIC_API_KEY,
    MODEL_AGENT6, AIC100_TIMEOUT_S,
    CLOUD_LLM_ENABLED, CLOUD_LLM_API_KEY, CLOUD_LLM_ENDPOINT, CLOUD_LLM_MODEL,
)

SYSTEM_PROMPT = (
    "You are CabinAI's advanced reasoning engine for a vehicle driving in Gachibowli, "
    "Hyderabad, Telangana, India on a route through the Outer Ring Road (ORR). "
    "You have full context: session history, fatigue forecast, route profile, driver profile. "
    "CRITICAL: All locations and rest stops MUST be in Hyderabad/Gachibowli area — NEVER mention "
    "European, American, or other foreign place names. Use ONLY these rest stops: "
    "Biodiversity Junction rest area, IKEA Hyderabad Nallagandla, DLF Cyber City fuel station, "
    "Gachibowli Stadium parking, ORR Emergency Bay, Shamshabad Airport, Hi-Tech City, "
    "Financial District service centre, ORR Toll Plaza, Nanakramguda Junction. "
    "Respond conversationally in 2-4 sentences. Be precise — the driver cannot read while driving. "
    "Answer the question DIRECTLY — never say 'Understood', 'Processing', or filler."
)

COACHING_PROMPT = """You are a driver safety coach. Analyse this complete driving session and produce a coaching report.

SESSION LOG:
{session_json}

Return ONLY valid JSON (no markdown):
{{
  "summary": "<2-3 sentence session summary>",
  "fatigue_events": [
    {{"timestamp_min": <int>, "description": "<what happened>", "severity": "<low|medium|high>"}}
  ],
  "recommendations": ["<actionable recommendation>"],
  "driver_profile_update": {{
    "typical_onset_min": <int>,
    "alert_style": "<gentle|firm>",
    "high_risk_conditions": ["<condition>"]
  }}
}}"""

MOCK_QUERY_RESPONSE = (
    "Based on your fatigue trend, I'd recommend a 20-minute stop at "
    "Biodiversity Junction (~3km ahead) or IKEA Hyderabad in Nallagandla. "
    "You've been driving long enough to take a short break — facilities and parking are available."
)

MOCK_COACHING = {
    "summary": (
        "Session of 45 minutes on the Gachibowli ↔ ORR ↔ Shamshabad corridor with 2 drowsiness "
        "events near the Durgam Cheruvu Tunnel. Fatigue onset matched your typical 68-minute window."
    ),
    "fatigue_events": [
        {"timestamp_min": 140, "description": "Blink rate dropped 34% over 4 min", "severity": "medium"},
        {"timestamp_min": 155, "description": "Perclos exceeded 15% threshold", "severity": "high"},
    ],
    "recommendations": [
        "Schedule mandatory break at 2 h 00 min on routes > 3 h.",
        "Depart 30 min earlier on high-curvature routes to reduce time pressure.",
        "Estimated incident risk reduction: 31%.",
    ],
    "driver_profile_update": {
        "typical_onset_min": 120,
        "alert_style": "gentle",
        "high_risk_conditions": ["night_driving", "post_meal", "highway_monotony"],
    },
}


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


def _chat(client, model: str, messages: list, max_tokens: int, temperature: float) -> str:
    response = client.chat.completions.create(
        model=model, messages=messages,
        max_tokens=max_tokens, temperature=temperature,
    )
    return response.choices[0].message.content


def handle_complex_query(query: str, context: dict, use_mock: bool = False) -> tuple[str, float]:
    """Returns (response_text, latency_ms)."""
    if use_mock or not QAIC_API_KEY:
        if CLOUD_LLM_ENABLED and CLOUD_LLM_API_KEY:
            return _do_query(_get_cloud_llm_client(), CLOUD_LLM_MODEL, query, context)
        time.sleep(1.2)
        return MOCK_QUERY_RESPONSE, 1200.0

    t0 = time.perf_counter()
    try:
        result = _do_query(_get_client(), MODEL_AGENT6, query, context)
        return result
    except Exception as aic100_err:
        if CLOUD_LLM_ENABLED and CLOUD_LLM_API_KEY:
            print(f"[Agent6] AIC100 error ({aic100_err}), falling back to QGenie")
            return _do_query(_get_cloud_llm_client(), CLOUD_LLM_MODEL, query, context)
        return MOCK_QUERY_RESPONSE, round((time.perf_counter() - t0) * 1000)


def _do_query(client, model: str, query: str, context: dict) -> tuple[str, float]:
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user",   "content": _build_context_prompt(query, context)},
    ]
    t0 = time.perf_counter()
    content = _chat(client, model, messages, max_tokens=250, temperature=0.3)
    return content, (time.perf_counter() - t0) * 1000


def generate_coaching_report(session_log: dict, use_mock: bool = False) -> tuple[dict, float]:
    """Returns (coaching_dict, latency_ms)."""
    if use_mock or not QAIC_API_KEY:
        if CLOUD_LLM_ENABLED and CLOUD_LLM_API_KEY:
            return _do_coaching(_get_cloud_llm_client(), CLOUD_LLM_MODEL, session_log)
        time.sleep(2.0)
        return MOCK_COACHING, 2000.0

    t0 = time.perf_counter()
    try:
        return _do_coaching(_get_client(), MODEL_AGENT6, session_log)
    except Exception as aic100_err:
        if CLOUD_LLM_ENABLED and CLOUD_LLM_API_KEY:
            print(f"[Agent6] AIC100 coaching error ({aic100_err}), falling back to QGenie")
            return _do_coaching(_get_cloud_llm_client(), CLOUD_LLM_MODEL, session_log)
        return MOCK_COACHING, round((time.perf_counter() - t0) * 1000)


def _do_coaching(client, model: str, session_log: dict) -> tuple[dict, float]:
    prompt = COACHING_PROMPT.format(session_json=json.dumps(session_log, indent=2))
    t0 = time.perf_counter()
    content = _chat(client, model, [{"role": "user", "content": prompt}],
                    max_tokens=800, temperature=0.2)
    latency_ms = (time.perf_counter() - t0) * 1000
    if "```" in content:
        content = content.split("```")[1]
        if content.startswith("json"):
            content = content[4:]
    try:
        return json.loads(content.strip()), latency_ms
    except Exception:
        return MOCK_COACHING, latency_ms


def _build_context_prompt(query: str, context: dict) -> str:
    lines = [f"Query: {query}", "", "Current context:"]
    for k, v in context.items():
        lines.append(f"  {k}: {v}")
    return "\n".join(lines)
