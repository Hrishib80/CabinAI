# CabinAI Cabin Companion — Android APK

A fully offline Android app that turns a Snapdragon 8 Elite phone into a
portable in-car AI co-pilot.

## What it does

- Listens to your voice via Distil-Whisper STT (Hexagon HTP, on-device)
- Answers questions using Qwen2.5-VL-7B via the Genie SDK (W4A16, on-device)
- Augments answers with local RAG over 31 Hyderabad landmark documents
- Speaks responses using Kokoro ONNX TTS

Zero bytes of network egress.  Works in airplane mode.

## Source

Built on top of the `myai` project at `/c/Users/vsahni/sparq/myai`,
which has a working Genie SDK + TierRouter + AgentLoop validated on
Snapdragon 8 Elite hardware.

## Architecture doc

See `docs/ANDROID_CABIN_COMPANION.md` in the CabinAI repo for the full
architecture, hardware targets, file reuse list, and demo script.

## Quick start

```bash
bash scripts/provision_model.sh   # push model files (~5 GB) via ADB
./gradlew assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```
