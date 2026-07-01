"""
tests/test_multilingual.py — Track 18: Hindi/Telugu multilingual STT+TTS tests.

Tests cover:
  - Voice mapping: language codes → Kokoro voice names
  - get_voice_for_language() for all supported languages + unknown fallback
  - STT language propagation through the transcribe endpoint
  - TTS language routing through the /api/tts/speak endpoint
  - STT_LANGUAGE config var default
"""
import sys, os, io

# Ensure backend package is importable from the repo root
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


# ---------------------------------------------------------------------------
# 1-4  Voice mapping tests
# ---------------------------------------------------------------------------

def test_voice_map_hindi():
    from backend.agents.local_tts import get_voice_for_language
    assert get_voice_for_language("hi") == "hf_alpha"


def test_voice_map_telugu():
    from backend.agents.local_tts import get_voice_for_language
    assert get_voice_for_language("te") == "hf_beta"


def test_voice_map_english():
    from backend.agents.local_tts import get_voice_for_language
    assert get_voice_for_language("en") == "af_bella"


def test_voice_map_unknown_falls_back_to_english():
    from backend.agents.local_tts import get_voice_for_language
    assert get_voice_for_language("fr") == "af_bella"
    assert get_voice_for_language("") == "af_bella"
    assert get_voice_for_language("xx") == "af_bella"


def test_voice_map_all_keys_present():
    from backend.agents.local_tts import LANGUAGE_VOICE_MAP
    assert "en" in LANGUAGE_VOICE_MAP
    assert "hi" in LANGUAGE_VOICE_MAP
    assert "te" in LANGUAGE_VOICE_MAP


# ---------------------------------------------------------------------------
# 5  STT_LANGUAGE config var
# ---------------------------------------------------------------------------

def test_stt_language_config_default():
    """STT_LANGUAGE defaults to 'en' unless overridden by env var."""
    import importlib, os as _os
    original = _os.environ.pop("STT_LANGUAGE", None)
    try:
        import backend.config as cfg
        importlib.reload(cfg)
        assert cfg.STT_LANGUAGE == "en"
    finally:
        if original is not None:
            _os.environ["STT_LANGUAGE"] = original
        importlib.reload(cfg)


def test_stt_language_config_override():
    """STT_LANGUAGE can be set to 'hi' via env var."""
    import importlib, os as _os
    original = _os.environ.get("STT_LANGUAGE")
    _os.environ["STT_LANGUAGE"] = "hi"
    try:
        import backend.config as cfg
        importlib.reload(cfg)
        assert cfg.STT_LANGUAGE == "hi"
    finally:
        if original is not None:
            _os.environ["STT_LANGUAGE"] = original
        else:
            _os.environ.pop("STT_LANGUAGE", None)
        importlib.reload(cfg)


# ---------------------------------------------------------------------------
# 6  TTS language routing — Flask endpoint (mock Kokoro)
# ---------------------------------------------------------------------------

def test_tts_speak_selects_hindi_voice(monkeypatch):
    """POST /api/tts/speak with language='hi' uses hf_alpha voice."""
    import importlib

    captured = {}

    def mock_synthesize(text, voice=None, speed=None):
        captured["voice"] = voice
        captured["text"] = text
        return b"RIFF....fake_wav_data", 50.0

    import backend.agents.local_tts as _tts_mod
    monkeypatch.setattr(_tts_mod, "synthesize", mock_synthesize)

    import backend.server as srv_mod
    importlib.reload(srv_mod)
    srv_mod.app.config["TESTING"] = True
    client = srv_mod.app.test_client()

    # Patch LOCAL_TTS_ENABLED so it reaches the Kokoro branch
    with monkeypatch.context() as m:
        m.setattr("backend.server.LOCAL_TTS_ENABLED", True)
        # Disable AIC100 path
        m.setattr("backend.server.STT_LANGUAGE", "en")
        import backend.config as cfg
        original_key = cfg.QAIC_API_KEY
        m.setattr(cfg, "QAIC_API_KEY", "")

        resp = client.post(
            "/api/tts/speak",
            json={"text": "नमस्ते", "language": "hi"},
            content_type="application/json",
        )
    # Should succeed with audio/wav (or fall through to 503 if Kokoro not installed)
    # Either way, the voice selected must be hf_alpha
    assert captured.get("voice") == "hf_alpha", (
        f"Expected voice hf_alpha for Hindi, got {captured.get('voice')!r}"
    )


def test_tts_speak_selects_telugu_voice(monkeypatch):
    """POST /api/tts/speak with language='te' uses hf_beta voice."""
    captured = {}

    def mock_synthesize(text, voice=None, speed=None):
        captured["voice"] = voice
        return b"RIFF....fake_wav_data", 50.0

    import backend.agents.local_tts as _tts_mod
    monkeypatch.setattr(_tts_mod, "synthesize", mock_synthesize)

    import backend.server as srv_mod
    srv_mod.app.config["TESTING"] = True
    client = srv_mod.app.test_client()

    with monkeypatch.context() as m:
        m.setattr("backend.server.LOCAL_TTS_ENABLED", True)
        import backend.config as cfg
        m.setattr(cfg, "QAIC_API_KEY", "")

        client.post(
            "/api/tts/speak",
            json={"text": "నమస్కారం", "language": "te"},
            content_type="application/json",
        )

    assert captured.get("voice") == "hf_beta", (
        f"Expected voice hf_beta for Telugu, got {captured.get('voice')!r}"
    )


# ---------------------------------------------------------------------------
# 7  Transcribe endpoint — language field propagated
# ---------------------------------------------------------------------------

def test_transcribe_passes_language_to_local_whisper(monkeypatch, tmp_path):
    """POST /api/agent3/transcribe passes language to local Whisper."""
    captured = {}

    def mock_transcribe_bytes(audio_bytes, language="en", **kwargs):
        captured["language"] = language
        return "test transcript", 100

    import backend.agents.local_whisper as _whisper_mod
    monkeypatch.setattr(_whisper_mod, "transcribe_bytes", mock_transcribe_bytes)

    import backend.server as srv_mod
    import backend.config as cfg
    monkeypatch.setattr(cfg, "QAIC_API_KEY", "")
    monkeypatch.setattr("backend.server.LOCAL_WHISPER_ENABLED", True)

    srv_mod.app.config["TESTING"] = True
    client = srv_mod.app.test_client()

    # Create a fake audio file large enough to pass the size check
    fake_audio = b"\x00" * 1000
    data = {"file": (io.BytesIO(fake_audio), "audio.webm"), "language": "hi"}
    resp = client.post(
        "/api/agent3/transcribe",
        data=data,
        content_type="multipart/form-data",
    )
    assert captured.get("language") == "hi", (
        f"Expected language='hi' forwarded to local_whisper, got {captured.get('language')!r}"
    )


# ---------------------------------------------------------------------------
# 8  prosody_clean is not broken by language tags (smoke test)
# ---------------------------------------------------------------------------

def test_prosody_clean_hindi_text_passthrough():
    """prosody_clean should pass Hindi text through without mangling Unicode."""
    from backend.agents.local_tts import prosody_clean
    hindi = "नमस्ते, कैसे हो?"
    result = prosody_clean(hindi)
    assert result == hindi  # no English abbreviations to expand; should be unchanged
