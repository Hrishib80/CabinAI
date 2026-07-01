"""
backend/agents/local_tts.py — Local TTS using Kokoro-ONNX.

Model files live in models/ at the project root.
  models/kokoro-v1.0.onnx   (318 MB)
  models/voices.bin          (28 MB)

Fallback chain for TTS:
  1. AIC100 MeloTTS-EN (if QAIC_API_KEY + VPN, via /api/tts/speak)
  2. Kokoro-ONNX local  (models/kokoro-v1.0.onnx + models/voices.bin)
  3. pyttsx3 Windows SAPI (guaranteed, always available)

Voice + speed are configurable via env so the demo voice can be hot-swapped:
  KOKORO_VOICE   (default af_bella — warm, natural female; af_heart was the old robotic-sounding default)
  KOKORO_SPEED   (default 1.0)
"""
import io, os, re, time, threading, wave
from pathlib import Path
import numpy as np

_kokoro_lock = threading.Lock()
_kokoro      = None

_MODELS_DIR  = Path(__file__).parent.parent.parent / "models"
_ONNX_PATH   = os.getenv("KOKORO_ONNX_PATH",  str(_MODELS_DIR / "kokoro-v1.0.onnx"))
_VOICES_PATH = os.getenv("KOKORO_VOICES_PATH", str(_MODELS_DIR / "voices.bin"))
_DEFAULT_VOICE = os.getenv("KOKORO_VOICE", "af_bella")
_DEFAULT_SPEED = float(os.getenv("KOKORO_SPEED", "1.0"))

LANGUAGE_VOICE_MAP = {
    "en": os.getenv("KOKORO_VOICE", "af_bella"),
    "hi": "hf_alpha",   # Hindi female
    "te": "hf_beta",    # Telugu female
}

def get_voice_for_language(lang: str) -> str:
    return LANGUAGE_VOICE_MAP.get(lang, LANGUAGE_VOICE_MAP["en"])

# Expand abbreviations / symbols that Kokoro otherwise reads letter-by-letter or
# mangles, which is the main source of the "robotic" feel. Order matters.
_ABBREV = [
    (re.compile(r"\bORR\b"),                  "Outer Ring Road"),
    (re.compile(r"\bDLF\b"),                  "D L F"),
    (re.compile(r"\bIKEA\b", re.I),           "Ikea"),
    (re.compile(r"\bNPU\b"),                  "N P U"),
    (re.compile(r"\bRPM\b", re.I),            "R P M"),
    (re.compile(r"\bkm/h\b", re.I),           "kilometres per hour"),
    (re.compile(r"\bkmph\b", re.I),           "kilometres per hour"),
    (re.compile(r"\bkph\b", re.I),            "kilometres per hour"),
    (re.compile(r"(\d+)\s*km\b", re.I),       r"\1 kilometres"),
    (re.compile(r"(\d+)\s*m\b"),              r"\1 metres"),
    (re.compile(r"\bAC\b"),                   "A C"),
    (re.compile(r"\bAI\b"),                   "A I"),
    (re.compile(r"&"),                        " and "),
]


def prosody_clean(text: str) -> str:
    """Light text normalisation so Kokoro reads naturally, not like a robot.

    Expands abbreviations, normalises whitespace, and ensures sentences have
    breathing room (a space after terminal punctuation) so prosody resets.
    """
    t = text.strip()
    for pat, repl in _ABBREV:
        t = pat.sub(repl, t)
    # Ensure a space after sentence-ending punctuation followed by a capital.
    t = re.sub(r"([.!?])([A-Z])", r"\1 \2", t)
    # Collapse runs of whitespace.
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _load_kokoro():
    global _kokoro
    if _kokoro is not None:
        return _kokoro
    from kokoro_onnx import Kokoro
    print(f"[LocalTTS] Loading Kokoro from {_ONNX_PATH} (voice={_DEFAULT_VOICE})")
    _kokoro = Kokoro(_ONNX_PATH, _VOICES_PATH)
    print("[LocalTTS] Kokoro ready")
    return _kokoro


def synthesize(text: str, voice: str = None, speed: float = None) -> tuple[bytes, float]:
    """Returns (wav_bytes, latency_ms). wav_bytes is a valid WAV file."""
    voice = voice or _DEFAULT_VOICE
    speed = speed if speed is not None else _DEFAULT_SPEED
    text = prosody_clean(text)[:500]
    if not text:
        return b"", 0.0

    t0 = time.perf_counter()
    try:
        with _kokoro_lock:
            kokoro = _load_kokoro()
            samples, sample_rate = kokoro.create(text, voice=voice, speed=speed)
        return _to_wav(samples, sample_rate), round((time.perf_counter() - t0) * 1000)
    except Exception as e:
        print(f"[LocalTTS] Kokoro error: {e}, falling back to pyttsx3")
        return _pyttsx3_fallback(text), round((time.perf_counter() - t0) * 1000)


def _to_wav(samples: np.ndarray, rate: int) -> bytes:
    buf = io.BytesIO()
    pcm = (samples * 32767).clip(-32768, 32767).astype(np.int16)
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(pcm.tobytes())
    return buf.getvalue()


def _pyttsx3_fallback(text: str) -> bytes:
    import tempfile
    try:
        import pyttsx3
        engine = pyttsx3.init()
        engine.setProperty("rate", 160)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tmp = f.name
        engine.save_to_file(text, tmp)
        engine.runAndWait()
        engine.stop()
        with open(tmp, "rb") as f:
            data = f.read()
        os.unlink(tmp)
        return data
    except Exception as e:
        print(f"[LocalTTS] pyttsx3 failed: {e}")
        return b""


def warm_up():
    def _w():
        with _kokoro_lock:
            try:
                _load_kokoro()
            except Exception as e:
                print(f"[LocalTTS] Warm-up failed: {e}")
    threading.Thread(target=_w, daemon=True).start()


def synthesize_stream(text: str, voice: str = None, speed: float = None):
    """Yields (wav_bytes, sentence_text, latency_ms) for each sentence."""
    sentences = re.split(r'(?<=[.!?])\s+', prosody_clean(text))
    sentences = [s.strip() for s in sentences if s.strip()]
    for sentence in sentences:
        wav, ms = synthesize(sentence, voice=voice, speed=speed)
        yield wav, sentence, ms
