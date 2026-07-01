"""
Validate CabinAI benchmark submission JSON against hackathon rules.

Checks:
  - >= 10 runs
  - total_latency_ms >= sum(stage latencies) for every run
  - device values: only NPU / GPU / CPU / Cloud
  - run_index sequential: 1, 2, 3, ...
  - status: only success / failed
  - fallback stages only follow failed stages
  - No cherry-picking indicators (runs should show normal variation)

Usage:
  .venv312/Scripts/python.exe scripts/validate_benchmark_json.py
"""
import json, sys
from pathlib import Path

JSON_PATH = Path(__file__).parent.parent / "phase2" / "hackathonSparq" / "CabinAI_benchmark_submission.json"

VALID_DEVICES = {"NPU", "GPU", "CPU", "Cloud"}
VALID_STATUSES = {"success", "failed"}
FALLBACK_MODELS = {"distil-whisper-small-en-onnx", "llama3.2-3b-instruct"}


def validate():
    if not JSON_PATH.exists():
        print(f"ERROR: File not found: {JSON_PATH}")
        return False

    with open(JSON_PATH) as f:
        data = json.load(f)

    errors = []
    warnings = []

    # Check metadata
    meta = data.get("metadata", {})
    if not meta.get("team_name"):
        errors.append("Missing metadata.team_name")
    if not meta.get("project_name"):
        errors.append("Missing metadata.project_name")
    if not meta.get("submission_date"):
        errors.append("Missing metadata.submission_date")

    runs = data.get("runs", [])

    # Check run count
    if len(runs) < 10:
        errors.append(f"Need >= 10 runs, got {len(runs)}")

    # Check sequential run_index
    for i, r in enumerate(runs):
        expected_idx = i + 1
        if r.get("run_index") != expected_idx:
            errors.append(f"Run {i+1}: run_index={r.get('run_index')}, expected {expected_idx}")

    # Per-run checks
    total_latencies = []
    for r in runs:
        idx = r.get("run_index", "?")
        stages = r.get("stages", [])
        total = r.get("total_latency_ms", 0)
        stage_sum = sum(s.get("latency_ms", 0) for s in stages)
        total_latencies.append(total)

        # total >= sum
        if total < stage_sum:
            errors.append(f"Run {idx}: total_latency_ms ({total}) < sum of stages ({stage_sum})")

        # Overhead check (warning if > 50ms)
        overhead = total - stage_sum
        if overhead > 50:
            warnings.append(f"Run {idx}: high orchestration overhead ({overhead}ms) - may hurt scoring")

        # Device values
        for s in stages:
            dev = s.get("device", "")
            if dev not in VALID_DEVICES:
                errors.append(f"Run {idx}: invalid device '{dev}'")

        # Status values
        for s in stages:
            st = s.get("status", "")
            if st not in VALID_STATUSES:
                errors.append(f"Run {idx}: invalid status '{st}'")

        # Fallback rule: fallback model must follow a failed stage
        for i, s in enumerate(stages):
            model_id = s.get("model_id", "")
            if model_id in FALLBACK_MODELS:
                if i == 0:
                    errors.append(f"Run {idx}: fallback stage '{model_id}' is the first stage (no preceding failure)")
                else:
                    prev = stages[i - 1]
                    if prev.get("status") != "failed":
                        errors.append(f"Run {idx}: fallback '{model_id}' follows stage with status='{prev.get('status')}' (should be 'failed')")

        # Check that failed stages don't have real output
        for s in stages:
            if s.get("status") == "failed":
                out_tokens = s.get("output", {}).get("tokens", 0)
                if out_tokens > 0:
                    warnings.append(f"Run {idx}: failed stage has output tokens={out_tokens}")

    # Variation check (not cherry-picked)
    if total_latencies:
        mean_lat = sum(total_latencies) / len(total_latencies)
        min_lat = min(total_latencies)
        max_lat = max(total_latencies)
        if max_lat > 0 and (max_lat - min_lat) / max_lat < 0.01 and len(runs) > 5:
            warnings.append("All runs have nearly identical latency - may look cherry-picked")

    # Print results
    print("=" * 60)
    print("CabinAI Benchmark JSON Validator")
    print("=" * 60)
    print(f"File: {JSON_PATH}")
    print(f"Runs: {len(runs)}")
    print(f"Total stages: {sum(len(r.get('stages',[])) for r in runs)}")
    if total_latencies:
        print(f"Mean total latency: {sum(total_latencies)/len(total_latencies):.0f}ms")
        print(f"Min/Max: {min(total_latencies)}ms / {max(total_latencies)}ms")
    print()

    if warnings:
        print(f"WARNINGS ({len(warnings)}):")
        for w in warnings:
            print(f"  ! {w}")
        print()

    if errors:
        print(f"ERRORS ({len(errors)}):")
        for e in errors:
            print(f"  x {e}")
        print()
        print("RESULT: FAIL")
        return False
    else:
        print("RESULT: PASS")
        print("  - Run count OK (>= 10)")
        print("  - All total_latency_ms >= sum(stages)")
        print("  - Device values valid (NPU/GPU/CPU/Cloud only)")
        print("  - run_index sequential")
        print("  - Fallback stages follow failed stages correctly")
        return True


if __name__ == "__main__":
    ok = validate()
    sys.exit(0 if ok else 1)
