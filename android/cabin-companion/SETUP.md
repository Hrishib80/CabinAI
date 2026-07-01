# Cabin Companion — Setup Guide

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Android Studio | Hedgehog 2023.1.1+ | |
| Android SDK | 34 | API level 34 (Android 14) |
| Android NDK | r26b | Required for Genie JNI layer |
| ADB | latest | Phone in developer mode, USB debugging on |
| Snapdragon 8 Elite device | SM8750 | 16 GB RAM recommended |
| Disk space | ~8 GB | For model files on device |

## Step 1 — Clone the repo

```bash
git clone <cabinai-repo>
cd cabinai/android/cabin-companion
```

## Step 2 — Copy genie-sdk from myai

The Genie SDK library is not included in the cabin-companion directory because
it lives alongside the myai project.  Copy it once:

```bash
cp -r /c/Users/vsahni/sparq/myai/android/genie-sdk ./genie-sdk
```

This provides the AAR + JNI layer for Qwen2.5-VL-7B on Hexagon.

## Step 3 — Provision models to device

Connect the Snapdragon 8 Elite device via USB (USB debugging enabled).

The `provision_model.sh` script (adapted from myai) pushes all model files to
`/sdcard/Android/data/com.sparq.cabinai/files/models/`:

```bash
bash scripts/provision_model.sh
```

Model files to provision (push manually if script fails):

```bash
# Qwen2.5-VL-7B bundle (~4.6 GB total)
adb push /c/Users/vsahni/sparq/myai/models/qwen_vl_bundle/qwen2_5_vl_7b_instruct-genie-w4a16-qualcomm_snapdragon_8_elite/ \
    /sdcard/Android/data/com.sparq.cabinai/files/models/qwen_vl/

# Distil-Whisper ONNX encoder + decoder
adb push /c/Users/vsahni/sparq/cabinai/models/distil_whisper_x_elite/ \
    /sdcard/Android/data/com.sparq.cabinai/files/models/whisper/

# Kokoro TTS
adb push /c/Users/vsahni/sparq/cabinai/models/kokoro-v1.0.onnx \
    /sdcard/Android/data/com.sparq.cabinai/files/models/
adb push /c/Users/vsahni/sparq/cabinai/models/voices.bin \
    /sdcard/Android/data/com.sparq.cabinai/files/models/

# BGE-small-en ONNX
adb push /c/Users/vsahni/sparq/cabinai/models/bge_small_en/ \
    /sdcard/Android/data/com.sparq.cabinai/files/models/bge/
```

Total transfer: ~5 GB.  Expect ~10 minutes over USB 3.0.

## Step 4 — Build

Open the project in Android Studio, or from the command line:

```bash
./gradlew assembleDebug
```

The debug APK is output to `app/build/outputs/apk/debug/app-debug.apk` (~45 MB).

## Step 5 — Install and launch

```bash
adb install app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.sparq.cabinai/.MainActivity
```

## Step 6 — Verify offline inference

1. Put the phone in **airplane mode**.
2. Open CabinAI Companion.
3. Tap the mic and ask: *"What's the speed limit on the ORR?"*
4. Expected answer in ~2 s: *"100 km/h on the Outer Ring Road."*
5. Go to **Settings → Apps → CabinAI Companion → Mobile data & Wi-Fi**.
   Confirm both counters show **0 B** for this session.

## Kotlin files reused from myai

| File | Notes |
|---|---|
| `TierRouter.kt` | Routes queries to Tier 1 (canned) / Tier 2 (Genie) — change package to `com.sparq.cabinai` |
| `tools/ToolRegistry.kt` | Tool dispatch — add `HyderabadRagTool` for cabin-specific RAG |
| `tools/AgentLoop.kt` | Async LLM loop with tool-use support |
| `genie-sdk/` | Qualcomm Genie SDK AAR |
| `AndroidManifest.xml` | Copy `assertNoInternet` permission block |
| `scripts/provision_model.sh` | Push model bundle via ADB |
