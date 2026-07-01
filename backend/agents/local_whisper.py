"""
backend/agents/local_whisper.py — Local STT using Distil-Whisper.

STT fallback chain:
  1. AIC100 openai/whisper-large-v3-turbo  (primary, best quality)
  2. ONNX Distil-Whisper on onnxruntime-qnn (models/distil_whisper_x_elite/)
     - encoder.onnx + decoder.onnx from HuggingFace distil-whisper/distil-small.en
     - Runs on Snapdragon X Elite HTP via onnxruntime-qnn if available,
       otherwise CPU via standard onnxruntime
  3. HuggingFace transformers pipeline (CPU, ~3-5s per clip)
  4. Error returned to browser (triggers Web Speech API browser-side)

Model download:
  python -c "from backend.agents.local_whisper import download_models; download_models()"
"""
import io, os, time, threading, warnings
from pathlib import Path
import numpy as np

# Suppress torch-absent warning from transformers — we use ONNX, not PyTorch
warnings.filterwarnings("ignore", message=".*PyTorch.*")
warnings.filterwarnings("ignore", message=".*torch.*")

# ── ARM64 Windows fix ──────────────────────────────────────────────────────
# On Windows-ARM64 the `soundfile` wheel ships no working libsndfile.dll, so
# `from transformers import WhisperProcessor` crashes at import time (transformers
# hard-imports soundfile in audio_utils.py). We never use soundfile — audio is
# decoded with PyAV and fed to the feature extractor as a raw numpy array — so we
# inject a harmless stub BEFORE transformers is imported. The stub satisfies the
# import + transformers' availability probe; any actual call raises clearly.
import sys as _sys
import importlib.machinery as _machinery
if "soundfile" not in _sys.modules:
    try:
        import soundfile as _real_sf  # noqa: F401  (works if libsndfile present)
    except Exception:
        _sf_stub = type(_sys)("soundfile")
        _sf_stub.__spec__ = _machinery.ModuleSpec("soundfile", loader=None)
        _sf_stub.__version__ = "0.0.0-stub"
        _sf_stub.SoundFile = object
        def _sf_unavailable(*_a, **_k):
            raise RuntimeError("soundfile unavailable on ARM64 — audio is decoded "
                               "via PyAV; this code path should not be reached")
        for _fn in ("read", "write", "info", "blocks"):
            setattr(_sf_stub, _fn, _sf_unavailable)
        _sf_stub.available_formats = lambda: {}
        _sf_stub.available_subtypes = lambda *_a, **_k: {}
        _sys.modules["soundfile"] = _sf_stub
        print("[LocalWhisper] soundfile unavailable (ARM64) — installed PyAV-only stub")

# Force offline — all model + processor files are local, no HF network calls
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

_lock        = threading.Lock()
_ort_session = None     # onnxruntime session (encoder + decoder as separate session objs)
_processor   = None     # cached WhisperProcessor (loaded from local dir)
_hf_pipe     = None     # HuggingFace pipeline fallback
_SAMPLE_RATE = 16000

_MODELS_DIR = Path(os.getenv("WHISPER_MODEL_DIR",
    str(Path(__file__).parent.parent.parent / "models" / "distil_whisper_x_elite")))

_ENCODER_PATH = _MODELS_DIR / "encoder.onnx"
_DECODER_PATH = _MODELS_DIR / "decoder.onnx"


def _get_processor():
    """Load WhisperProcessor from the local model dir (offline)."""
    global _processor
    if _processor is not None:
        return _processor
    from transformers import WhisperProcessor
    _processor = WhisperProcessor.from_pretrained(str(_MODELS_DIR), local_files_only=True)
    return _processor



def _load_ort():
    """Load onnxruntime sessions for encoder and decoder."""
    global _ort_session
    if _ort_session is not None:
        return _ort_session

    if not _ENCODER_PATH.exists() or not _DECODER_PATH.exists():
        return None

    try:
        import onnxruntime as ort
        # Use QNN execution provider if available (NPU), else CPU
        providers = ort.get_available_providers()
        ep = ["QNNExecutionProvider"] if "QNNExecutionProvider" in providers else ["CPUExecutionProvider"]
        print(f"[LocalWhisper] Loading ONNX encoder/decoder with {ep}")
        enc = ort.InferenceSession(str(_ENCODER_PATH), providers=ep)
        dec = ort.InferenceSession(str(_DECODER_PATH), providers=ep)
        _ort_session = (enc, dec)
        print("[LocalWhisper] ONNX sessions ready")
        return _ort_session
    except Exception as e:
        print(f"[LocalWhisper] ORT load failed: {e}")
        return None


def _load_hf():
    global _hf_pipe
    if _hf_pipe is not None:
        return _hf_pipe
    try:
        from transformers import pipeline
        import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"[LocalWhisper] Loading HF Distil-Whisper pipeline on {device}")
        _hf_pipe = pipeline(
            "automatic-speech-recognition",
            model="distil-whisper/distil-small.en",
            device=device,
            torch_dtype=torch.float16 if device == "cuda" else torch.float32,
            chunk_length_s=30,
            stride_length_s=5,
        )
        print("[LocalWhisper] HF pipeline ready")
        return _hf_pipe
    except Exception as e:
        print(f"[LocalWhisper] HF pipeline load failed: {e}")
        return None


def transcribe_bytes(audio_bytes: bytes, mime_type: str = "audio/webm", language: str = "en") -> tuple[str, float]:
    """Returns (transcript, latency_ms)."""
    t0 = time.perf_counter()

    samples = _decode_audio(audio_bytes)
    if samples is None or len(samples) < _SAMPLE_RATE * 0.3:
        return "", 0.0

    with _lock:
        # Try ONNX path first (faster on NPU)
        ort_sessions = _load_ort()
        if ort_sessions:
            text = _transcribe_onnx(samples, ort_sessions, language=language)
            if text:
                return text.strip(), round((time.perf_counter() - t0) * 1000)

        # Fallback to HF transformers
        pipe = _load_hf()
        if pipe:
            # Set forced_decoder_ids for non-English languages
            generate_kwargs = {}
            if language in ("hi", "te"):
                generate_kwargs["language"] = language
                generate_kwargs["task"] = "transcribe"
            result = pipe({"raw": samples, "sampling_rate": _SAMPLE_RATE},
                          generate_kwargs=generate_kwargs if generate_kwargs else None)
            text   = (result.get("text") or "").strip()
            return text, round((time.perf_counter() - t0) * 1000)

    return "", round((time.perf_counter() - t0) * 1000)


def _transcribe_onnx(samples: np.ndarray, sessions, language: str = "en") -> str:
    """Run encoder-decoder ONNX inference with greedy decoding."""
    try:
        processor = _get_processor()
        tok       = processor.tokenizer
        enc_session, dec_session = sessions

        # Preprocess audio → log-mel features
        inputs = processor(samples, return_tensors="np", sampling_rate=_SAMPLE_RATE)
        input_features = inputs["input_features"].astype(np.float32)

        # Encoder
        enc_out     = enc_session.run(["last_hidden_state"], {"input_features": input_features})
        last_hidden = enc_out[0]

        # Whisper forced decoder prompt tokens depend on language
        sot  = tok.convert_tokens_to_ids("<|startoftranscript|>")
        lang_token = tok.convert_tokens_to_ids(f"<|{language}|>") if language != "en" else tok.convert_tokens_to_ids("<|en|>")
        tr   = tok.convert_tokens_to_ids("<|transcribe|>")
        nots = tok.convert_tokens_to_ids("<|notimestamps|>")
        eos  = tok.eos_token_id
        generated = [t for t in [sot, lang_token, tr, nots] if t is not None]

        for _ in range(200):
            dec_input = np.array([generated], dtype=np.int64)
            dec_out   = dec_session.run(["logits"], {
                "input_ids": dec_input,
                "encoder_hidden_states": last_hidden,
            })
            next_token = int(np.argmax(dec_out[0][0, -1, :]))
            if next_token == eos:
                break
            generated.append(next_token)

        # Decode, skipping the forced-prompt special tokens
        return tok.decode(generated, skip_special_tokens=True).strip()
    except Exception as e:
        print(f"[LocalWhisper] ONNX transcription error: {e}")
        return ""


def _decode_audio(audio_bytes: bytes) -> np.ndarray | None:
    """Decode WebM/opus bytes to float32 numpy array at 16 kHz using av."""
    try:
        import av
        container  = av.open(io.BytesIO(audio_bytes))
        resampler  = av.AudioResampler(format="fltp", layout="mono", rate=_SAMPLE_RATE)
        chunks     = []
        for frame in container.decode(audio=0):
            for rf in resampler.resample(frame):
                chunks.append(rf.to_ndarray()[0])
        for rf in resampler.resample(None):
            chunks.append(rf.to_ndarray()[0])
        return np.concatenate(chunks).astype(np.float32) if chunks else None
    except Exception as e:
        print(f"[LocalWhisper] Audio decode error: {e}")
        return None


def download_models():
    """Download Distil-Whisper ONNX files from HuggingFace. Run once."""
    try:
        from huggingface_hub import hf_hub_download
        import shutil
        _MODELS_DIR.mkdir(parents=True, exist_ok=True)
        for src, dst in [("onnx/encoder_model.onnx", _ENCODER_PATH),
                         ("onnx/decoder_model.onnx", _DECODER_PATH)]:
            if dst.exists():
                print(f"[LocalWhisper] {dst.name} already downloaded")
                continue
            print(f"[LocalWhisper] Downloading {src}...")
            p = hf_hub_download("distil-whisper/distil-small.en", src, local_dir=str(_MODELS_DIR))
            shutil.move(p, dst)
            print(f"[LocalWhisper] {dst.name} saved ({dst.stat().st_size//1024//1024}MB)")
    except Exception as e:
        print(f"[LocalWhisper] Download failed: {e}")


def warm_up():
    """Load models in background (ONNX first, HF as fallback)."""
    def _w():
        with _lock:
            try:
                if _load_ort():
                    return
                _load_hf()
            except Exception as e:
                print(f"[LocalWhisper] Warm-up failed: {e}")
    threading.Thread(target=_w, daemon=True).start()
