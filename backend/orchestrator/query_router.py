"""
Query routing: decides whether a transcribed query goes to Agent 4 (edge)
or Agent 6 (cloud, AIC100 Qwen3-30B).
Rule-based, <1 ms, no model inference.
"""

TEMPORAL_RE_TERMS   = {"yesterday", "last", "history", "before", "previous", "week", "month"}
EXTERNAL_DATA_TERMS = {"weather", "traffic", "news", "nearby", "restaurant", "hotel",
                       "station", "gas", "fuel", "price", "open", "closed", "recall",
                       "service", "dealer", "warning", "light", "serious"}
COMPLEX_TERMS       = {"should", "recommend", "feel", "tired", "stop", "risk",
                       "safe", "dangerous", "advice", "suggest"}


def route_query(features: dict, bus_state: dict) -> str:
    """
    features: dict with keys:
      token_count       (int)
      has_temporal_ref  (bool)
      has_external_data (bool)
      is_complex        (bool)
      agent7_escalate   (bool)   — set by Agent 7 when local confidence < 0.7
    Returns: 'AGENT4' | 'AGENT6'
    """
    if features.get("token_count", 0) > 15:
        return "AGENT6"
    if features.get("has_temporal_ref"):
        return "AGENT6"
    if features.get("has_external_data"):
        return "AGENT6"
    if features.get("is_complex"):
        return "AGENT6"
    if features.get("agent7_escalate") or bus_state.get("agent7_escalate"):
        return "AGENT6"
    return "AGENT4"


def extract_features(text: str) -> dict:
    tokens = text.lower().split()
    token_set = set(tokens)
    return {
        "token_count":       len(tokens),
        "has_temporal_ref":  bool(token_set & TEMPORAL_RE_TERMS),
        "has_external_data": bool(token_set & EXTERNAL_DATA_TERMS),
        "is_complex":        bool(token_set & COMPLEX_TERMS),
        "agent7_escalate":   False,
    }
