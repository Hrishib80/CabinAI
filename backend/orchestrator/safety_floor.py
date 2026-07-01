"""
Safety floor — deterministic regex dispatcher.
Fires BEFORE any LLM routing.  Returns sub-50 ms.
"""
import re
import time
from typing import Optional

# ---------------------------------------------------------------------------
# Route index map (mirrors HYDERABAD_ROUTE in driving_game.js — 17 entries)
# ---------------------------------------------------------------------------
_ROUTE_NAMES = [
    "Gachibowli Stadium",
    "Gachibowli Main Road",
    "Mindspace Junction",
    "DLF Cyber City",
    "DLF Fuel Station",
    "Financial District",
    "Durgam Cheruvu Tunnel",
    "Nanakramguda Junction",
    "Biodiversity Junction",
    "IKEA Hyderabad, Nallagandla",
    "Nallagandla Township",
    "Hi-Tech City",
    "Madhapur Flyover",
    "ORR Toll Plaza",
    "ORR Emergency Bay",
    "ORR Highway",
    "Shamshabad Airport",
]

# Lowercase → index for O(1) lookup
_ROUTE_INDEX: dict[str, int] = {n.lower(): i for i, n in enumerate(_ROUTE_NAMES)}

# Also index individual keywords so partial names resolve
_ROUTE_KEYWORDS: list[tuple[str, int]] = sorted(
    [(n.lower(), i) for i, n in enumerate(_ROUTE_NAMES)],
    key=lambda t: -len(t[0]),  # longest match wins
)


def _route_idx(location_str: str) -> Optional[int]:
    loc = location_str.strip().lower()
    # Exact match first
    if loc in _ROUTE_INDEX:
        return _ROUTE_INDEX[loc]
    # Partial / keyword match (longest-first so "DLF Cyber City" beats "DLF")
    for name, idx in _ROUTE_KEYWORDS:
        if name in loc or loc in name:
            return idx
    return None


# ---------------------------------------------------------------------------
# Compiled patterns
# ---------------------------------------------------------------------------

_RULES: list[tuple[re.Pattern, str, object]] = [
    # ── Climate / AC ─────────────────────────────────────────────────────────
    (re.compile(r"\b(turn on (the )?a[/. ]?c|turn on air.?conditioning)\b", re.I),
     "CABIN_AC_ON", True),
    (re.compile(r"\b(turn off (the )?a[/. ]?c|turn off air.?conditioning)\b", re.I),
     "CABIN_AC_OFF", False),

    # ── Locks ─────────────────────────────────────────────────────────────────
    (re.compile(r"\b(lock (the )?doors?|lock (the )?car)\b", re.I),
     "CABIN_LOCK", True),
    (re.compile(r"\b(unlock (the )?doors?|unlock (the )?car)\b", re.I),
     "CABIN_UNLOCK", False),

    # ── Windows ───────────────────────────────────────────────────────────────
    (re.compile(r"\b(open (the )?windows?)\b", re.I),
     "CABIN_WINDOWS_OPEN", True),
    (re.compile(r"\b(close (the )?windows?)\b", re.I),
     "CABIN_WINDOWS_CLOSE", False),

    # ── Mute / Unmute ─────────────────────────────────────────────────────────
    (re.compile(r"\b(mute)\b", re.I),
     "CABIN_MUTE", True),
    (re.compile(r"\b(unmute)\b", re.I),
     "CABIN_UNMUTE", False),

    # ── Alert dismiss ─────────────────────────────────────────────────────────
    (re.compile(r"\b(dismiss alert|cancel alert|stop alert)\b", re.I),
     "CABIN_DISMISS_ALERT", None),

    # ── Game weather ──────────────────────────────────────────────────────────
    (re.compile(r"\b(make it rain|^rain$)\b", re.I),
     "GAME_WEATHER", "rain"),
    (re.compile(r"\b(clear weather|clear skies)\b", re.I),
     "GAME_WEATHER", "clear"),
    (re.compile(r"\b(make it foggy|^fog$)\b", re.I),
     "GAME_WEATHER", "fog"),

    # ── Game speed ────────────────────────────────────────────────────────────
    (re.compile(r"\b(speed up|faster)\b", re.I),
     "GAME_SPEED", +20),
    (re.compile(r"\b(slow down|slower|brake)\b", re.I),
     "GAME_SPEED", -20),

    # ── Game stop ─────────────────────────────────────────────────────────────
    (re.compile(r"\b(stop driving|stop the car)\b", re.I),
     "GAME_STOP", None),

    # ── Game pause / resume ───────────────────────────────────────────────────
    (re.compile(r"\b(pause the drive|^pause$)\b", re.I),
     "GAME_PAUSE", None),
    (re.compile(r"\b(resume driving|^resume$)\b", re.I),
     "GAME_RESUME", None),
]

# Navigation: "take me to / navigate to / go to <location>"
_GAME_JUMP_RE = re.compile(
    r"\b(?:take me to|navigate to|go to)\s+(.+?)(?:\s*[!?.]*\s*$)",
    re.I,
)


# ---------------------------------------------------------------------------
# Human-readable labels
# ---------------------------------------------------------------------------
_LABELS: dict[str, str] = {
    "CABIN_AC_ON":        "AC on",
    "CABIN_AC_OFF":       "AC off",
    "CABIN_LOCK":         "Doors locked",
    "CABIN_UNLOCK":       "Doors unlocked",
    "CABIN_WINDOWS_OPEN": "Windows open",
    "CABIN_WINDOWS_CLOSE":"Windows closed",
    "CABIN_MUTE":         "Muted",
    "CABIN_UNMUTE":       "Unmuted",
    "CABIN_DISMISS_ALERT":"Alert dismissed",
    "GAME_WEATHER":       "Weather changed",
    "GAME_SPEED":         "Speed adjusted",
    "GAME_STOP":          "Stopped",
    "GAME_PAUSE":         "Paused",
    "GAME_RESUME":        "Resumed",
    "GAME_JUMP":          "Jumping to location",
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def dispatch(transcript: str) -> Optional[dict]:
    """
    Returns {action, value, label, latency_ms} if a cabin command matched,
    or None if no rule matched (caller then routes to Agent4/6 as normal).
    """
    t0 = time.perf_counter()
    text = transcript.strip()

    # Navigation intent — check first (captures multi-word locations)
    m = _GAME_JUMP_RE.search(text)
    if m:
        location_str = m.group(1).strip()
        idx = _route_idx(location_str)
        if idx is not None:
            return {
                "action":     "GAME_JUMP",
                "value":      idx,
                "label":      f"Navigate to {_ROUTE_NAMES[idx]}",
                "latency_ms": round((time.perf_counter() - t0) * 1000, 2),
            }
        # Location not recognised — fall through to LLM

    # Fixed-pattern rules
    for pattern, action, value in _RULES:
        if pattern.search(text):
            label = _LABELS.get(action, action)
            if action == "GAME_SPEED":
                label = "Speed up" if value > 0 else "Slow down"
            elif action == "GAME_WEATHER":
                label = f"Weather: {value}"
            return {
                "action":     action,
                "value":      value,
                "label":      label,
                "latency_ms": round((time.perf_counter() - t0) * 1000, 2),
            }

    return None
