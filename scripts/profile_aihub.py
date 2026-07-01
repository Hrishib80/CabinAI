"""
scripts/profile_aihub.py — Submit Qualcomm AI Hub profiling jobs for CabinAI's on-device models.

Models profiled:
  - BGE-small-en-v1.5 (RAG embedder, Agent 7)
  - Distil-Whisper encoder + decoder (STT, Agent 3 local fallback)
  - Kokoro-v1.0 TTS ONNX

Devices targeted (5 devices covering automotive + mobile + laptop SoCs):
  - Snapdragon X Elite (laptop — our dev machine)
  - Snapdragon 8 Elite (our phone — myai is already running on this)
  - Snapdragon 8 Gen 3 (common flagship phone)
  - SA8295P ADP (automotive SoC)
  - QCS8550 (IoT / low-power)

Output: phase2/deliverables/aihub_profiling.json
Run:    python scripts/profile_aihub.py [--wait]
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

# Force UTF-8 output on Windows (qai_hub wait() prints unicode spinner chars)
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf-8', buffering=1, closefd=False)
    sys.stderr = open(sys.stderr.fileno(), mode='w', encoding='utf-8', buffering=1, closefd=False)

ROOT = Path(__file__).parent.parent
DELIVERABLES = ROOT / "phase2" / "deliverables"
DELIVERABLES.mkdir(parents=True, exist_ok=True)
OUTPUT = DELIVERABLES / "aihub_profiling.json"

MODELS = [
    {
        "name": "bge-small-en-v1.5",
        "path": ROOT / "models" / "bge_small_en" / "onnx" / "model_int32.onnx",
        "description": "BGE-small-en RAG embedder (Agent 7) — int32 inputs",
        "input_specs": {
            "input_ids":      ((1, 64),   "int32"),
            "attention_mask": ((1, 64),   "int32"),
            "token_type_ids": ((1, 64),   "int32"),
        },
        "compile_options": "",  # no int64 inputs after re-export
    },
    {
        "name": "distil-whisper-encoder",
        "path": ROOT / "models" / "distil_whisper_x_elite" / "encoder.onnx",
        "description": "Distil-Whisper STT encoder (Agent 3 local)",
        "input_specs": {
            "input_features": ((1, 80, 3000), "float32"),
        },
        "compile_options": "",
    },
    {
        "name": "distil-whisper-decoder",
        "path": ROOT / "models" / "distil_whisper_x_elite" / "decoder.onnx",
        "description": "Distil-Whisper STT decoder (Agent 3 local)",
        "input_specs": {
            "input_ids":             ((1, 1),       "int64"),
            "encoder_hidden_states": ((1, 1500, 768), "float32"),
        },
        "compile_options": "--truncate_64bit_io",
    },
    {
        "name": "kokoro-v1.0-tts-static",
        "path": ROOT / "models" / "kokoro-v1.0-static50.onnx",
        "description": "Kokoro TTS ONNX (static seq=50 for AI Hub)",
        "input_specs": {
            "tokens": ((1, 50),  "int64"),
            "style":  ((1, 256), "float32"),
            "speed":  ((1,),     "float32"),
        },
        "compile_options": "--truncate_64bit_io",
    },
]

# Target devices by their AI Hub name substrings — will match the first device
# whose name contains the key string (case-insensitive).
DEVICE_QUERIES = [
    "Snapdragon X Elite",
    "Snapdragon 8 Elite",
    "Snapdragon 8 Gen 3 (Family)",
    "SA8295P ADP",
    "QCS8550 (Proxy)",
]


def find_device(client, query: str):
    """Find the first device whose name contains query (case-insensitive)."""
    q = query.lower()
    for d in client.get_devices():
        if q in d.name.lower():
            return d
    return None


def submit_jobs(wait: bool):
    import qai_hub as hub

    # Resolve devices
    devices = []
    for q in DEVICE_QUERIES:
        d = find_device(hub, q)
        if d:
            devices.append(d)
            print(f"  Found device: {d.name}")
        else:
            print(f"  WARNING: no device matching '{q}'")

    if not devices:
        print("ERROR: no devices found — check qai-hub credentials")
        sys.exit(1)

    jobs = []  # (job, model_name, device_name)

    for model_info in MODELS:
        path = model_info["path"]
        if not path.exists():
            print(f"  SKIP {model_info['name']}: file not found at {path}")
            continue

        print(f"\nUploading {model_info['name']} ({path.stat().st_size // 1024 // 1024} MB)...")
        try:
            model = hub.upload_model(str(path))
            print(f"  Uploaded: {model.model_id}")
        except Exception as e:
            print(f"  Upload failed: {e}")
            continue

        for device in devices:
            try:
                input_specs_raw = model_info.get("input_specs")
                if input_specs_raw:
                    # qai_hub v0.50 InputSpecs format: dict[str, tuple[tuple[int,...], str]]
                    # i.e. {tensor_name: ((dim1, dim2, ...), "dtype")}
                    specs = {
                        name: (shape, dtype)
                        for name, (shape, dtype) in input_specs_raw.items()
                    }
                    compile_job = hub.submit_compile_job(
                        model=model,
                        device=device,
                        input_specs=specs,
                        options=model_info.get("compile_options", ""),
                        name=f"cabinai-{model_info['name'][:20]}",
                    )
                    print(f"  Compile {device.name}: {compile_job.job_id} ...", end=" ", flush=True)
                    compile_job.wait()
                    compile_status = compile_job.get_status()
                    if not compile_status.success:
                        print(f"FAILED: {getattr(compile_status, 'message', str(compile_status))}")
                        continue
                    compiled_model = compile_job.get_target_model()
                    print(f"OK -> {compiled_model.model_id}")
                    # Profile the compiled (static-shape) model
                    job = hub.submit_profile_job(
                        model=compiled_model,
                        device=device,
                        name=f"cabinai-{model_info['name'][:20]}-profile",
                    )
                else:
                    job = hub.submit_profile_job(model=model, device=device)
                jobs.append((job, model_info["name"], device.name))
                print(f"  Profile job {device.name}: {job.job_id}")
            except Exception as e:
                import traceback; traceback.print_exc()
                print(f"  Failed {device.name}: {e}")

    if not jobs:
        print("No jobs submitted.")
        return

    print(f"\nSubmitted {len(jobs)} profiling jobs total.")
    if not wait:
        # Save job IDs for later collection
        pending = [{"job_id": j.job_id, "model": m, "device": d} for j, m, d in jobs]
        with open(OUTPUT.with_suffix(".pending.json"), "w") as f:
            json.dump(pending, f, indent=2)
        print(f"Job IDs saved to {OUTPUT.with_suffix('.pending.json')}")
        print("Run again with --wait to poll and save results.")
        return

    collect_results(jobs)


def collect_results(jobs=None):
    import qai_hub as hub

    # If called standalone (no jobs arg), load from pending file
    if jobs is None:
        pending_path = OUTPUT.with_suffix(".pending.json")
        if not pending_path.exists():
            print(f"No pending jobs file at {pending_path}")
            sys.exit(1)
        with open(pending_path) as f:
            pending = json.load(f)
        jobs = [(hub.get_job(p["job_id"]), p["model"], p["device"]) for p in pending]

    results = []
    print(f"\nWaiting for {len(jobs)} jobs to complete (this may take 10-30 min)...")
    for job, model_name, device_name in jobs:
        print(f"  Waiting: {model_name} on {device_name} (job {job.job_id})...", end=" ", flush=True)
        try:
            # j.wait() blocks until the job finishes (success or failure).
            job.wait()

            status = job.get_status()
            print(str(status.code))

            if not status.success:
                results.append({
                    "model": model_name,
                    "device": device_name,
                    "status": "failed",
                    "error": str(status.message) if hasattr(status, 'message') else str(status.code),
                })
                continue

            # Extract profiling results
            try:
                profile = job.download_profile()
            except Exception as pe:
                profile = None
                print(f"    (profile download failed: {pe})")

            row = {
                "model": model_name,
                "device": device_name,
                "status": "success",
                "job_id": job.job_id,
                "job_url": f"https://workbench.aihub.qualcomm.com/jobs/{job.job_id}/",
            }
            if profile and isinstance(profile, dict):
                summary = profile.get("execution_summary", {})
                inf_us = summary.get("estimated_inference_time")
                mem_b  = summary.get("estimated_inference_peak_memory")
                row["inference_time_ms"]  = round(inf_us / 1000, 2) if inf_us else None
                row["peak_memory_mb"]     = round(mem_b  / 1024 / 1024, 1) if mem_b else None
                row["warm_load_time_ms"]  = round(summary.get("warm_load_time", 0) / 1000, 1)
                # Layer distribution per compute unit
                layers = profile.get("layers", [])
                npu = sum(1 for l in layers if l.get("compute_unit", "").upper() == "NPU")
                cpu = sum(1 for l in layers if l.get("compute_unit", "").upper() == "CPU")
                gpu = sum(1 for l in layers if l.get("compute_unit", "").upper() == "GPU")
                row["npu_layers"] = npu; row["cpu_layers"] = cpu; row["gpu_layers"] = gpu
                total_layers = npu + cpu + gpu
                row["npu_pct"] = round(npu / total_layers * 100, 1) if total_layers else None

            print(f"    -> {row.get('inference_time_ms', '?')} ms, "
                  f"{row.get('peak_memory_mb', '?')} MB, "
                  f"NPU {row.get('npu_pct', '?')}%")
            results.append(row)

        except Exception as e:
            print(f"ERROR: {e}")
            results.append({"model": model_name, "device": device_name,
                            "status": "error", "error": str(e)})

    out = {
        "metadata": {
            "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "team": "RoboClaw",
            "project": "CabinAI — Hybrid Multi-Agent VLA",
            "models_profiled": list({r["model"] for r in results}),
            "devices_profiled": list({r["device"] for r in results}),
        },
        "results": results,
    }
    with open(OUTPUT, "w") as f:
        json.dump(out, f, indent=2)
    n_ok = sum(1 for r in results if r["status"] == "success")
    print(f"\nResults saved to {OUTPUT}")
    print(f"Summary: {n_ok}/{len(results)} successful")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--wait", action="store_true", help="Wait for jobs and collect results in one pass")
    p.add_argument("--collect", action="store_true", help="Only collect results from previously submitted jobs")
    args = p.parse_args()

    if args.collect:
        collect_results()
    else:
        submit_jobs(wait=args.wait)


if __name__ == "__main__":
    main()
