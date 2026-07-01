#!/usr/bin/env python3
"""
scripts/export_models.py
========================
Downloads and prepares on-device models for CabinAI.

Run with Python 3.12 ARM64 (has qai-hub, huggingface_hub):
  "C:/Users/vsahni/AppData/Local/Programs/Python/Python312-arm64/python.exe" scripts/export_models.py

OR via run.ps1:
  .\run.ps1 -export

What this does:
  1. Configures qai-hub with QUAL_AI_HUB_API token from .env
  2. Downloads Distil-Whisper ONNX from HuggingFace (encoder.onnx + decoder.onnx)
     - ~332 MB encoder + ~450 MB decoder
     - Saved to models/distil_whisper_x_elite/
  3. Reports all model status (Kokoro, MeloTTS, Distil-Whisper)
"""
import os, sys, pathlib, shutil

ROOT        = pathlib.Path(__file__).parent.parent
MODELS_DIR  = ROOT / "models"
MODELS_DIR.mkdir(exist_ok=True)
WHISPER_OUT = MODELS_DIR / "distil_whisper_x_elite"
WHISPER_OUT.mkdir(exist_ok=True)

# Load .env
env_path = ROOT / ".env"
env_vars = {}
if env_path.exists():
    for line in env_path.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, _, v = line.partition("=")
            env_vars[k.strip()] = v.strip()

HUB_TOKEN = env_vars.get("QUAL_AI_HUB_API", "")

print("=" * 60)
print("CabinAI - Model Download/Export")
print(f"Python  : {sys.version.split()[0]}")
print(f"Models  : {MODELS_DIR}")
print("=" * 60)

# ── 1. Configure qai-hub ──────────────────────────────────────────
try:
    import qai_hub
    print(f"\n[1/3] qai-hub {qai_hub.__version__} found")
    if HUB_TOKEN:
        import subprocess
        cli = pathlib.Path(sys.executable).parent / "qai-hub.exe"
        subprocess.run([str(cli), "configure", "--api_token", HUB_TOKEN],
                       capture_output=True)
        print("      Token configured.")
except ImportError:
    print("[1/3] qai-hub not found (not required for ONNX download)")

# ── 2. Download Distil-Whisper ONNX ──────────────────────────────
print(f"\n[2/3] Distil-Whisper ONNX (distil-whisper/distil-small.en)...")

ONNX_FILES = [
    ("onnx/encoder_model.onnx", "encoder.onnx"),
    ("onnx/decoder_model.onnx", "decoder.onnx"),
]

all_present = all((WHISPER_OUT / name).exists() for _, name in ONNX_FILES)

if all_present:
    print("      Already downloaded. Skipping.")
else:
    try:
        os.environ["HF_HUB_OFFLINE"] = "0"
        from huggingface_hub import hf_hub_download
        for src, name in ONNX_FILES:
            dest = WHISPER_OUT / name
            if dest.exists():
                print(f"      {name} already exists ({dest.stat().st_size//1024//1024}MB)")
                continue
            print(f"      Downloading {name}... (~300-450MB, please wait)")
            p = hf_hub_download(
                "distil-whisper/distil-small.en", src,
                local_dir=str(WHISPER_OUT),
            )
            if str(p) != str(dest):
                shutil.move(p, dest)
            print(f"      OK: {dest.stat().st_size//1024//1024}MB")
        print("      Distil-Whisper ONNX ready.")
        # Update .env
        env_text = env_path.read_text()
        if "WHISPER_MODEL_DIR=" in env_text:
            env_text = "\n".join(
                f"WHISPER_MODEL_DIR={WHISPER_OUT}" if l.startswith("WHISPER_MODEL_DIR=") else l
                for l in env_text.splitlines()
            )
            env_path.write_text(env_text)
        print(f"      Updated .env: WHISPER_MODEL_DIR={WHISPER_OUT}")
    except ImportError:
        print("      huggingface_hub not installed.")
        print("      Run: python -m pip install huggingface_hub")
    except Exception as e:
        print(f"      Error: {e}")

# ── 3. Model inventory ────────────────────────────────────────────
melotts_dir   = MODELS_DIR / "melotts_en-voice_ai-mixed_with_float-qualcomm_snapdragon_x_elite"
kokoro_onnx   = MODELS_DIR / "kokoro-v1.0.onnx"
kokoro_voices = MODELS_DIR / "voices.bin"

def size(p): return f"{p.stat().st_size//1024//1024}MB" if p.exists() else "MISSING"

print(f"\n[3/3] Model inventory at {MODELS_DIR}:")
print(f"  MeloTTS-EN .bin  : {'OK' if melotts_dir.exists() else 'NOT FOUND'} ({melotts_dir.name if melotts_dir.exists() else ''})")
print(f"  Kokoro ONNX      : {size(kokoro_onnx)}")
print(f"  Kokoro voices    : {size(kokoro_voices)}")
for _, n in ONNX_FILES:
    p = WHISPER_OUT / n
    print(f"  Distil {n:<25}: {size(p)}")
print("\nDone.")
