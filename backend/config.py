import os
from dotenv import load_dotenv

load_dotenv()

# ── QAIC Inference Gateway ─────────────────────────────────────────────────────
HYDRA_BASE_URL = os.getenv(
    "HYDRA_BASE_URL",
    "https://your-inference-gateway.example.com/aips/sparq/api/v1"
)
APIGEE_TOKEN = os.getenv(
    "APIGEE_TOKEN",
    "kHAEOnGs3WCSeRt9Si5xRWvdDi4PbWavoDy27jNTuCkBmWgn"
)
QAIC_API_KEY = os.getenv("QAIC_API_KEY", "")

# ── Qualcomm AI Hub (model export/download — qai-hub requires Python 3.10-3.13) ──
QUAL_AI_HUB_API = os.getenv("QUAL_AI_HUB_API", "")

# ── Model IDs ─────────────────────────────────────────────────────────────────
MODEL_AGENT5 = os.getenv("MODEL_AGENT5", "qwen3_vl_32b_instruct")
MODEL_AGENT6 = os.getenv("MODEL_AGENT6", "gpt-oss-20b")
MODEL_EMBED  = os.getenv("MODEL_EMBED",  "bge-m3")
MODEL_STT    = os.getenv("MODEL_STT",    "openai/whisper-large-v3-turbo")
MODEL_IMAGE  = os.getenv("MODEL_IMAGE",  "stabilityai-sdxl-turbo")

# ── Agent 4 (edge LLM) ────────────────────────────────────────────────────────
AGENT4_BACKEND    = os.getenv("AGENT4_BACKEND", "ollama")
OLLAMA_BASE_URL   = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL      = os.getenv("OLLAMA_MODEL", "qwen2:7b")
QWEN7B_MODEL_PATH = os.getenv("QWEN7B_MODEL_PATH", "")

# ── QGenie fallback ───────────────────────────────────────────────────────────
CLOUD_LLM_ENABLED  = os.getenv("CLOUD_LLM_ENABLED", "false").lower() == "true"
CLOUD_LLM_API_KEY  = os.getenv("CLOUD_LLM_API_KEY", "")
CLOUD_LLM_ENDPOINT = os.getenv("CLOUD_LLM_ENDPOINT", "https://your-cloud-llm.example.com/v1")
CLOUD_LLM_MODEL    = os.getenv("CLOUD_LLM_MODEL",    "anthropic::claude-4-5-sonnet")

# ── Local on-device models (Snapdragon X Elite, always available after warm-up) ─
# STT: distil-whisper/distil-small.en via HuggingFace transformers + torch CPU
# TTS: Kokoro-ONNX via kokoro-onnx package
LOCAL_WHISPER_ENABLED = os.getenv("LOCAL_WHISPER_ENABLED", "true").lower() == "true"
LOCAL_TTS_ENABLED     = os.getenv("LOCAL_TTS_ENABLED",    "true").lower() == "true"
LOCAL_TTS_VOICE       = os.getenv("LOCAL_TTS_VOICE",      "af_bella")  # warm/natural; af_heart sounded robotic
WHISPER_ONNX_PATH     = os.getenv("WHISPER_ONNX_PATH", "")  # legacy path
STT_LANGUAGE          = os.getenv("STT_LANGUAGE",         "en")  # default language for STT (en/hi/te)

# ── Flask ──────────────────────────────────────────────────────────────────────
FLASK_PORT  = int(os.getenv("FLASK_PORT", 5000))
FLASK_DEBUG = os.getenv("FLASK_DEBUG", "false").lower() == "true"

# ── Limits ─────────────────────────────────────────────────────────────────────
AIC100_TIMEOUT_S  = 15
SYNC_INTERVAL_S   = 300
MAX_PAYLOAD_BYTES = 32 * 1024
