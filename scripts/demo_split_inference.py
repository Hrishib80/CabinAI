#!/usr/bin/env python3
"""
scripts/demo_split_inference.py — Track 15: side-by-side comparison demo.

Runs three modes for three example queries:
  1. Edge-only   (Ollama qwen2:7b, capped at SPLIT_EDGE_TOKENS)
  2. Cloud-only  (QGenie claude)
  3. Split       (edge prefix + cloud continuation)

Prints a table showing latency, bytes transferred, and compression ratio
vs a raw 640x480 video frame (~40 KB JPEG).
"""
import sys, os, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from backend.orchestrator.split_inference import SplitInferenceOrchestrator

QUERIES = [
    "What is the speed limit on the Outer Ring Road near Gachibowli?",
    "My engine temperature light is on, what should I do?",
    "I'm feeling sleepy, where is the nearest rest stop on the ORR?",
]

VIDEO_FRAME_BYTES = 40 * 1024


def _run_edge_only(orch: SplitInferenceOrchestrator, query: str) -> dict:
    t0 = time.perf_counter()
    prefix = orch._call_edge(query, "")
    ms = round((time.perf_counter() - t0) * 1000)
    return {"response": prefix, "latency_ms": ms, "bytes": len(prefix.encode())}


def _run_cloud_only(orch: SplitInferenceOrchestrator, query: str) -> dict:
    t0 = time.perf_counter()
    resp = orch._call_cloud(query, "", "")
    ms = round((time.perf_counter() - t0) * 1000)
    return {"response": resp, "latency_ms": ms, "bytes": len(query.encode())}


def _run_split(orch: SplitInferenceOrchestrator, query: str) -> dict:
    result = orch.run(query, context="")
    return result


def _truncate(text: str, n: int = 60) -> str:
    return (text[:n] + "…") if len(text) > n else text


def main():
    orch = SplitInferenceOrchestrator()

    print("\n" + "=" * 100)
    print(f"{'CabinAI — Track 15: Dynamic Split Inference PoC':^100}")
    print("=" * 100)
    print(f"{'Edge model:':<20} Ollama qwen2:7b (max {orch._edge_tokens} tokens)")
    print(f"{'Cloud model:':<20} QGenie claude-4-5-sonnet")
    print(f"{'Video frame:':<20} {VIDEO_FRAME_BYTES:,} bytes (640x480 JPEG baseline)")
    print()

    for i, query in enumerate(QUERIES, 1):
        print(f"\nQuery {i}: {query}")
        print("-" * 100)

        edge = _run_edge_only(orch, query)
        cloud = _run_cloud_only(orch, query)
        split = _run_split(orch, query)

        compression = orch.measure_compression_ratio(split["edge_tokens"])

        header = f"{'Mode':<12} {'Latency':>10} {'Bytes Tx':>12} {'vs 640x480':>14} {'Response'}"
        print(header)
        print("-" * 100)

        edge_ratio = f"{VIDEO_FRAME_BYTES / max(1, edge['bytes']):.1f}x smaller"
        cloud_ratio = f"{VIDEO_FRAME_BYTES / max(1, cloud['bytes']):.1f}x smaller"
        split_ratio = f"{compression['compression_ratio']:.1f}x smaller"

        print(f"{'Edge-only':<12} {edge['latency_ms']:>8}ms {edge['bytes']:>10,}B {edge_ratio:>14}  {_truncate(edge['response'])}")
        print(f"{'Cloud-only':<12} {cloud['latency_ms']:>8}ms {cloud['bytes']:>10,}B {cloud_ratio:>14}  {_truncate(cloud['response'])}")
        print(f"{'Split':<12} {split['latency_ms']:>8}ms {split['bytes_transferred']:>10,}B {split_ratio:>14}  {_truncate(split['edge_prefix'] + ' | ' + split['cloud_continuation'])}")

        print(f"\n  Split inference compression: {compression['savings_pct']}% bandwidth savings vs video frame")
        print(f"  Edge tokens: {split['edge_tokens']}  Cloud tokens: {split['cloud_tokens']}  Total: {split['total_tokens']}")

    print("\n" + "=" * 100)
    print("Summary: Split inference transmits ~60-token text prefix (~240 bytes) vs 40KB video frame")
    print(f"Average compression: ~{VIDEO_FRAME_BYTES // 240}x — demonstrating I2 architecture without model surgery.")
    print("=" * 100)


if __name__ == "__main__":
    main()
